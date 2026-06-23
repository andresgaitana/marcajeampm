import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyPin } from "./pin.server";
import { verifyPassword } from "./password.server";
import { haversineMeters } from "./geo";
import { validateSelfie } from "./selfie-validation.server";
import { employeeCanMarkAtStore } from "./marcaje-auth.server";
import { facesMatch } from "./face-match.server";

const MAX_SELFIE_ATTEMPTS = 4;
const SELFIE_BLOCK_MINUTES = 15;

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
      .select("id, code, name, terminal_pin_hash, active, latitude, longitude, geofence_radius_m, zone_id")
      .eq("code", data.storeCode)
      .maybeSingle();
    if (!store || !store.active) return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };
    if (!verifyPin(data.terminalPin, store.terminal_pin_hash))
      return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };

    const { data: employee, error: empErr } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, store_id, pin_hash, password_hash, active, failed_selfie_attempts, selfie_blocked_until, face_descriptor")
      .in("employee_code", codeCandidates(data.employeeCode))
      .maybeSingle();

    if (empErr) throw new Error("Error consultando colaborador");
    if (!employee) return { ok: false as const, error: "Código no encontrado" };
    if (!employee.active) return { ok: false as const, error: "Colaborador inactivo" };
    if (employee.selfie_blocked_until && new Date(employee.selfie_blocked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(employee.selfie_blocked_until).getTime() - Date.now()) / 60000);
      return { ok: false as const, error: `Bloqueado por selfies inválidas. Reintenta en ${mins} min o contacta al GT.` };
    }
    // Autorización de marcaje por tienda según rol (tienda ancla / zona del GZ / multi-tienda del GT)
    if (!(await employeeCanMarkAtStore(employee, store))) {
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
    // Política degradada: solo se exige si el colaborador ya está enrolado
    // (tiene face_descriptor). Los no enrolados marcan normal hasta enrolarse.
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

    // 4) Geocerca OBLIGATORIA: la tienda debe tener coordenadas y el colaborador
    // debe estar físicamente dentro del radio (default 300 m).
    let distanceM: number | null = null;
    if (store.latitude == null || store.longitude == null) {
      return { ok: false as const, error: "Esta tienda no tiene ubicación configurada. Contacta al administrador." };
    }
    if (data.latitude == null || data.longitude == null) {
      return { ok: false as const, error: "Activa la ubicación (GPS) del dispositivo para poder marcar." };
    }
    distanceM = haversineMeters(store.latitude, store.longitude, data.latitude, data.longitude);
    const locationValid = distanceM <= (store.geofence_radius_m ?? 300);
    if (!locationValid) {
      return { ok: false as const, error: `Estás a ${Math.round(distanceM)}m de la tienda. Acércate (máx ${store.geofence_radius_m ?? 300}m).` };
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

    const { error: insErr } = await supabaseAdmin
      .from("attendance_records")
      .insert({
        employee_id: employee.id,
        type: data.type,
        store_id: store.id,
        selfie_url: pub.publicUrl,
        notes: faceOverrideBy ? `Marcaje autorizado por supervisor (override facial). ${data.notes ?? ""}`.trim() : (data.notes ?? null),
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        location_accuracy_m: data.locationAccuracyM ?? null,
        location_valid: locationValid,
        auth_method: authMethod,
        face_override_by: faceOverrideBy,
      });
    if (insErr) return { ok: false as const, error: "Error guardando marcaje" };

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
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: store } = await supabaseAdmin
      .from("stores").select("id, zone_id").eq("code", data.storeCode).maybeSingle();
    if (!store) return { found: false as const };
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, active, store_id, pin_hash, password_hash, username")
      .in("employee_code", codeCandidates(data.employeeCode))
      .maybeSingle();
    if (!emp || !emp.active) return { found: false as const };
    if (!(await employeeCanMarkAtStore(emp, store))) {
      return { found: false as const, wrongStore: true as const };
    }
    const { count: credCount } = await supabaseAdmin
      .from("employee_credentials")
      .select("*", { count: "exact", head: true })
      .eq("employee_id", emp.id);
    return {
      found: true as const,
      full_name: emp.full_name,
      role: emp.role,
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