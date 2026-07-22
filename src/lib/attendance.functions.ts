import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyPin, hashPin } from "./pin.server";
import { verifyPassword } from "./password.server";
import { haversineMeters } from "./geo";
import { validateSelfie } from "./selfie-validation.server";
import { employeeCanMarkAtStore } from "./marcaje-auth.server";
import { facesMatch } from "./face-match.server";

const MAX_SELFIE_ATTEMPTS = 5;
const SELFIE_BLOCK_MINUTES = 5;

/**
 * Build candidate employee_code lookups from user input. The phone keypad
 * makes the "-" hard to type, so accept both "GTA91" and "GT-A91", and any
 * lower/upper case mix. Returns a small array of exact-match candidates.
 */
function codeCandidates(raw: string): string[] {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const noDash = cleaned.replace(/-/g, "");
  const set = new Set<string>([cleaned, noDash]);
  // Insert dash between leading letters and the rest (e.g. GTA91 -> GT-A91)
  const m = noDash.match(/^([A-Z]+)([0-9].*|[A-Z][0-9].*)$/);
  if (m) set.add(`${m[1]}-${m[2]}`);
  // Aceptar prefijo GT/GZ tecleado sin guion (GZMGAS -> GZ-MGAS, GZFORS1 -> GZ-FORS1, GTA91 -> GT-A91)
  const p = noDash.match(/^(GT|GZ)(.+)$/);
  if (p) set.add(`${p[1]}-${p[2]}`);
  return [...set].filter(Boolean);
}

const markInput = z.object({
  employeeCode: z.string().trim().min(1).max(32),
  type: z.enum(["entrada", "salida"]),
  selfieDataUrl: z.string().min(20).max(8_000_000), // base64 data url
  notes: z.string().max(300).optional(),
  storeCode: z.string().trim().min(1).max(32),
  terminalPin: z.string().trim().min(4).max(12),
  // Auth method: exactly one of these must be provided
  pin: z.string().trim().min(4).max(8).optional(),
  // Nuevo PIN cuando el colaborador entra con un PIN restablecido (1234) y debe
  // cambiarlo en su primer marcaje.
  newPin: z.string().trim().regex(/^\d{4,8}$/).optional(),
  password: z.string().min(1).max(72).optional(),
  webauthnResponse: z.any().optional(),
  // Optional client geolocation
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  locationAccuracyM: z.number().min(0).max(100000).optional(),
  // Descriptor facial (128 floats) calculado en cliente con face-api, para
  // verificar identidad contra la foto de referencia del colaborador.
  faceDescriptor: z.array(z.number()).length(128).optional(),
  // Override de supervisor (GT/GZ) cuando el reconocimiento facial falla.
  supervisorCode: z.string().trim().min(1).max(32).optional(),
  supervisorPin: z.string().trim().min(4).max(8).optional(),
  // Datos del guarda para la cuenta compartida de Seguridad Tercerizada.
  guardName: z.string().trim().max(120).optional(),
  guardCompany: z.string().trim().max(120).optional(),
  // Área del turno (polivalentes que cubren la otra área): productos | mbk.
  area: z.enum(["productos", "mbk"]).optional(),
  // Cobertura: el colaborador está cubriendo en una tienda que no es la suya.
  cobertura: z.boolean().optional(),
});

/**
 * Valida un override de supervisor (Gerente de Tienda / Gerente de Zona) para
 * autorizar un marcaje cuando el reconocimiento facial falla. Devuelve el id del
 * supervisor si su PIN es correcto y tiene autoridad sobre la tienda, o null.
 */
async function validateSupervisorOverride(
  code: string | undefined,
  pin: string | undefined,
  store: { id: string; zone_id: string | null },
): Promise<string | null> {
  if (!code || !pin) return null;
  const { data: sup } = await supabaseAdmin
    .from("employees")
    .select("id, role, store_id, pin_hash, active")
    .in("employee_code", codeCandidates(code))
    .maybeSingle();
  if (!sup || !sup.active) return null;
  if (sup.role !== "gerente" && sup.role !== "gerente_zona") return null;
  if (!sup.pin_hash || !verifyPin(pin, sup.pin_hash)) return null;
  if (!(await employeeCanMarkAtStore(sup, store))) return null;
  return sup.id;
}

/**
 * Public marcaje endpoint. Validates terminal store + PIN, then verifies
 * employee PIN, uploads selfie, and creates an attendance record.
 */
export const markAttendance = createServerFn({ method: "POST" })
  .inputValidator((input) => markInput.parse(input))
  .handler(async ({ data }) => {
    // 1) Validate terminal (store + terminal PIN)
    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("id, code, name, terminal_pin_hash, active, latitude, longitude, geofence_radius_m, zone_id, skip_geofence")
      .eq("code", data.storeCode)
      .maybeSingle();
    if (!store || !store.active) return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };
    if (!verifyPin(data.terminalPin, store.terminal_pin_hash))
      return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };

    const { data: employee, error: empErr } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, store_id, pin_hash, password_hash, active, failed_selfie_attempts, selfie_blocked_until, face_descriptor, must_change_pin")
      .in("employee_code", codeCandidates(data.employeeCode))
      .maybeSingle();

    if (empErr) throw new Error("Error consultando colaborador");
    if (!employee) return { ok: false as const, error: "Código no encontrado" };
    if (!employee.active) return { ok: false as const, error: "Colaborador inactivo" };
    if (employee.selfie_blocked_until && new Date(employee.selfie_blocked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(employee.selfie_blocked_until).getTime() - Date.now()) / 60000);
      return { ok: false as const, error: `Bloqueado por selfies inválidas. Reintenta en ${mins} min o contacta al GT.` };
    }
    // Autorización de marcaje por tienda según rol (tienda ancla / zona del GZ / multi-tienda del GT).
    // En modo COBERTURA se permite marcar en cualquier tienda (el agente presta apoyo); la
    // identidad la garantizan igual el reconocimiento facial + la geocerca.
    const esCobertura = !!data.cobertura && employee.store_id !== store.id;
    if (!esCobertura && !(await employeeCanMarkAtStore(employee, store))) {
      return { ok: false as const, error: `Este colaborador no puede marcar en ${store.name}` };
    }

    // 2) Validate authentication: exactly one method
    const provided = [data.pin, data.password, data.webauthnResponse].filter(Boolean).length;
    if (provided !== 1)
      return { ok: false as const, error: "Selecciona un único método de autenticación" };

    let authMethod: "pin" | "password" | "webauthn" = "pin";
    if (data.pin) {
      if (!employee.pin_hash || !verifyPin(data.pin, employee.pin_hash))
        return { ok: false as const, error: "PIN incorrecto" };
      authMethod = "pin";
    } else if (data.password) {
      if (!employee.password_hash || !(await verifyPassword(data.password, employee.password_hash)))
        return { ok: false as const, error: "Contraseña incorrecta" };
      authMethod = "password";
    } else if (data.webauthnResponse) {
      const { data: ch } = await supabaseAdmin
        .from("webauthn_challenges")
        .select("id, challenge, expires_at")
        .eq("employee_id", employee.id).eq("purpose", "auth")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!ch) return { ok: false as const, error: "Sin reto activo de huella" };
      if (new Date(ch.expires_at).getTime() < Date.now())
        return { ok: false as const, error: "El reto de huella expiró" };
      const credId = data.webauthnResponse?.id as string | undefined;
      if (!credId) return { ok: false as const, error: "Respuesta de huella inválida" };
      const { data: cred } = await supabaseAdmin
        .from("employee_credentials")
        .select("id, credential_id, public_key, counter")
        .eq("employee_id", employee.id).eq("credential_id", credId).maybeSingle();
      if (!cred) return { ok: false as const, error: "Huella no reconocida" };
      try {
        const req = getRequest();
        const url = new URL(req.url);
        const result = await verifyAuthenticationResponse({
          response: data.webauthnResponse,
          expectedChallenge: ch.challenge,
          expectedOrigin: url.origin,
          expectedRPID: url.hostname,
          credential: {
            id: cred.credential_id,
            publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64")),
            counter: Number(cred.counter),
          },
        });
        if (!result.verified) return { ok: false as const, error: "Huella no verificada" };
        await supabaseAdmin.from("employee_credentials")
          .update({ counter: result.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
          .eq("id", cred.id);
        await supabaseAdmin.from("webauthn_challenges").delete().eq("id", ch.id);
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : "Error verificando huella" };
      }
      authMethod = "webauthn";
    }

    // 2.5) Cambio de PIN obligatorio: tras un reseteo el colaborador entra con
    // 1234 y debe definir un PIN propio antes de poder marcar. Solo aplica a la
    // autenticación por PIN. El cambio se aplica al final, si el marcaje culmina.
    if (authMethod === "pin" && employee.must_change_pin) {
      if (!data.newPin) {
        return {
          ok: false as const,
          mustChangePin: true as const,
          error: "Tu PIN fue restablecido. Crea un nuevo PIN para continuar.",
        };
      }
      if (data.newPin === "1234" || data.newPin === data.pin) {
        return {
          ok: false as const,
          mustChangePin: true as const,
          error: "El nuevo PIN no puede ser 1234. Elige un PIN distinto.",
        };
      }
    }

    // 3) AI selfie validation (Google Gemini, direct)
    const v = await validateSelfie(data.selfieDataUrl);
    if (!v.ok) {
      const attempts = (employee.failed_selfie_attempts ?? 0) + 1;
      const remaining = Math.max(0, MAX_SELFIE_ATTEMPTS - attempts);
      const patch: { failed_selfie_attempts: number; selfie_blocked_until?: string | null } = {
        failed_selfie_attempts: attempts,
      };
      let blockMsg = "";
      if (attempts >= MAX_SELFIE_ATTEMPTS) {
        const until = new Date(Date.now() + SELFIE_BLOCK_MINUTES * 60_000).toISOString();
        patch.selfie_blocked_until = until;
        patch.failed_selfie_attempts = 0; // reset counter; block timer takes over
        blockMsg = ` Bloqueado por ${SELFIE_BLOCK_MINUTES} minutos.`;
      }
      await supabaseAdmin.from("employees").update(patch).eq("id", employee.id);
      return {
        ok: false as const,
        error: `${v.error}${attempts >= MAX_SELFIE_ATTEMPTS ? "" : ` (Intento ${attempts}/${MAX_SELFIE_ATTEMPTS})`}${blockMsg}`,
        remainingAttempts: remaining,
      };
    }

    // 3.5) Verificación de IDENTIDAD facial contra la foto de referencia.
    // El enrolamiento es OBLIGATORIO: nadie marca sin rostro registrado, EXCEPTO la
    // seguridad tercerizada (cuenta rotativa compartida, sin foto de referencia).
    const isEnrolled = Array.isArray(employee.face_descriptor) && employee.face_descriptor.length === 128;
    if (!isEnrolled && employee.role !== "seguridad_tercerizada") {
      return {
        ok: false as const,
        error: "No tienes tu rostro registrado. Pídele a tu Gerente que te enrole antes de marcar.",
      };
    }
    let faceOverrideBy: string | null = null;
    if (Array.isArray(employee.face_descriptor) && employee.face_descriptor.length === 128) {
      const matches = Array.isArray(data.faceDescriptor)
        && facesMatch(employee.face_descriptor, data.faceDescriptor);
      if (!matches && (data.supervisorCode || data.supervisorPin)) {
        faceOverrideBy = await validateSupervisorOverride(data.supervisorCode, data.supervisorPin, store);
        if (!faceOverrideBy)
          return { ok: false as const, error: "Supervisor no válido o sin autoridad en esta tienda." };
      } else if (!matches) {
        const attempts = (employee.failed_selfie_attempts ?? 0) + 1;
        const remaining = Math.max(0, MAX_SELFIE_ATTEMPTS - attempts);
        const patch: { failed_selfie_attempts: number; selfie_blocked_until?: string | null } = {
          failed_selfie_attempts: attempts,
        };
        let blockMsg = "";
        if (attempts >= MAX_SELFIE_ATTEMPTS) {
          patch.selfie_blocked_until = new Date(Date.now() + SELFIE_BLOCK_MINUTES * 60_000).toISOString();
          patch.failed_selfie_attempts = 0;
          blockMsg = ` Bloqueado por ${SELFIE_BLOCK_MINUTES} minutos.`;
        }
        await supabaseAdmin.from("employees").update(patch).eq("id", employee.id);
        return {
          ok: false as const,
          error: `El rostro no coincide con ${employee.full_name}. Debe marcar la persona correcta.${attempts >= MAX_SELFIE_ATTEMPTS ? "" : ` (Intento ${attempts}/${MAX_SELFIE_ATTEMPTS})`}${blockMsg}`,
          remainingAttempts: remaining,
        };
      }
    }

    // 4) Geocerca: la tienda debe tener coordenadas. Si el dispositivo NO da ubicación
    // o cae FUERA del radio, el marcaje se permite solo con autorización de un supervisor
    // (Gerente/GZ con autoridad en la tienda) y queda REGISTRADO (location_valid=false,
    // nota y quién autorizó). NO se exige precisión de GPS: las tablets ubican por WiFi/red
    // y la presencia la refuerzan el terminal fijo + la selfie en vivo + el rostro.
    let distanceM: number | null = null;
    let locationOverrideBy: string | null = null;
    let locationValid = true;
    let hasLoc = false;
    // Tiendas demo/capacitación (skip_geofence) NO validan geocerca: marcan desde cualquier lugar.
    if (!store.skip_geofence) {
      if (store.latitude == null || store.longitude == null) {
        return { ok: false as const, error: "Esta tienda no tiene ubicación configurada. Contacta al administrador." };
      }
      hasLoc = data.latitude != null && data.longitude != null;
      if (hasLoc) distanceM = haversineMeters(store.latitude, store.longitude, data.latitude as number, data.longitude as number);
      locationValid = hasLoc && (distanceM as number) <= (store.geofence_radius_m ?? 300);
      if (!locationValid) {
        const credsGiven = !!(data.supervisorCode || data.supervisorPin);
        const sup = credsGiven
          ? await validateSupervisorOverride(data.supervisorCode, data.supervisorPin, store)
          : null;
        if (!sup) {
          if (credsGiven) {
            // Credencial enviada pero inválida → mensaje claro (igual que el override facial).
            return { ok: false as const, error: "Supervisor no válido o sin autoridad en esta tienda.", needsSupervisor: true as const };
          }
          const base = !hasLoc
            ? "No se pudo obtener la ubicación del dispositivo."
            : `Estás a ${Math.round(distanceM as number)}m de la tienda (máx ${store.geofence_radius_m ?? 300}m).`;
          return { ok: false as const, error: `${base} Un supervisor (Gerente) puede autorizar el marcaje.`, needsSupervisor: true as const };
        }
        locationOverrideBy = sup;
      }
    }

    // Upload selfie (data URL -> bytes)
    const match = data.selfieDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return { ok: false as const, error: "Selfie inválida" };
    const mime = match[1];
    const ext = mime.split("/")[1] || "jpg";
    const bytes = Buffer.from(match[2], "base64");
    const path = `${employee.id}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from("attendance-selfies")
      .upload(path, bytes, { contentType: mime, upsert: false });
    if (upErr) return { ok: false as const, error: "Error subiendo selfie" };

    const { data: pub } = supabaseAdmin.storage
      .from("attendance-selfies")
      .getPublicUrl(path);

    // Notas: datos del guarda (tercerizada), override de supervisor y/o notas libres.
    const noteParts: string[] = [];
    if (data.guardName) noteParts.push(`Guarda tercerizado: ${data.guardName}${data.guardCompany ? ` (${data.guardCompany})` : ""}`);
    if (faceOverrideBy) noteParts.push("Marcaje autorizado por supervisor (override facial).");
    if (locationOverrideBy) noteParts.push(`Marcaje ${hasLoc ? "fuera de rango" : "sin ubicación"} autorizado por supervisor.`);
    if (data.notes) noteParts.push(data.notes);
    const finalNotes = noteParts.length ? noteParts.join(" · ") : null;

    const { error: insErr } = await supabaseAdmin
      .from("attendance_records")
      .insert({
        employee_id: employee.id,
        type: data.type,
        store_id: store.id,
        selfie_url: pub.publicUrl,
        notes: finalNotes,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        location_accuracy_m: data.locationAccuracyM ?? null,
        location_valid: locationValid,
        auth_method: authMethod,
        face_override_by: faceOverrideBy ?? locationOverrideBy, // supervisor que autorizó (rostro o ubicación)
        area: data.area ?? null,
        cobertura: esCobertura,
      });
    if (insErr) return { ok: false as const, error: "Error guardando marcaje" };

    // Aplicar el cambio de PIN obligatorio recién ahora que el marcaje culminó.
    if (authMethod === "pin" && employee.must_change_pin && data.newPin) {
      await supabaseAdmin.from("employees")
        .update({ pin_hash: hashPin(data.newPin), must_change_pin: false })
        .eq("id", employee.id);
    }

    // Reset failed counter on successful marcaje
    if ((employee.failed_selfie_attempts ?? 0) > 0 || employee.selfie_blocked_until) {
      await supabaseAdmin.from("employees")
        .update({ failed_selfie_attempts: 0, selfie_blocked_until: null })
        .eq("id", employee.id);
    }

    return {
      ok: true as const,
      employee: {
        full_name: employee.full_name,
        role: employee.role,
        store: store.name,
      },
      type: data.type,
      timestamp: new Date().toISOString(),
      locationValid,
      distanceM,
    };
  });

/**
 * Lookup employee name by code (no PIN). Used to give friendly
 * feedback ("Hola, María") before requesting the PIN.
 */
export const lookupEmployee = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({
      employeeCode: z.string().trim().min(1).max(32),
      storeCode: z.string().trim().min(1).max(32),
      // Modo cobertura: acepta a un colaborador de OTRA tienda (apoyo).
      cover: z.boolean().optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: store } = await supabaseAdmin
      .from("stores").select("id, zone_id").eq("code", data.storeCode).maybeSingle();
    if (!store) return { found: false as const };
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, active, store_id, polivalente, pin_hash, password_hash, username")
      .in("employee_code", codeCandidates(data.employeeCode))
      .maybeSingle();
    if (!emp || !emp.active) return { found: false as const };
    const canMark = await employeeCanMarkAtStore(emp, store);
    // Sin cobertura: solo colaboradores de esta tienda. Con cobertura: se acepta a
    // cualquiera, marcando que viene de otra tienda (apoyo).
    if (!canMark && !data.cover) {
      return { found: false as const, wrongStore: true as const };
    }
    const fromOtherStore = !canMark && emp.store_id !== store.id;
    const { count: credCount } = await supabaseAdmin
      .from("employee_credentials")
      .select("*", { count: "exact", head: true })
      .eq("employee_id", emp.id);
    return {
      found: true as const,
      full_name: emp.full_name,
      role: emp.role,
      polivalente: !!emp.polivalente,
      fromOtherStore,
      hasPin: !!emp.pin_hash,
      hasPassword: !!emp.password_hash,
      hasWebauthn: (credCount ?? 0) > 0,
      username: emp.username ?? null,
    };
  });

/**
 * Validate terminal store code + terminal PIN. Returns store info to cache on
 * the device. Used during terminal setup.
 */
export const validateTerminal = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({
      storeCode: z.string().trim().min(1).max(32),
      terminalPin: z.string().trim().min(4).max(12),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("id, code, name, terminal_pin_hash, active")
      .eq("code", data.storeCode)
      .maybeSingle();
    if (!store) return { ok: false as const, error: "Tienda no encontrada" };
    if (!store.active) return { ok: false as const, error: "Tienda inactiva" };
    if (!verifyPin(data.terminalPin, store.terminal_pin_hash))
      return { ok: false as const, error: "PIN de terminal incorrecto" };
    return { ok: true as const, store: { id: store.id, code: store.code, name: store.name } };
  });