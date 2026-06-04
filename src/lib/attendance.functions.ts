import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyPin } from "./pin.server";
import { verifyPassword } from "./password.server";
import { haversineMeters } from "./geo";

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
});

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
      .select("id, code, name, terminal_pin_hash, active, latitude, longitude, geofence_radius_m")
      .eq("code", data.storeCode)
      .maybeSingle();
    if (!store || !store.active) return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };
    if (!verifyPin(data.terminalPin, store.terminal_pin_hash))
      return { ok: false as const, error: "Terminal no válida. Reconfigura la tienda." };

    const { data: employee, error: empErr } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, store_id, pin_hash, password_hash, active")
      .eq("employee_code", data.employeeCode)
      .maybeSingle();

    if (empErr) throw new Error("Error consultando colaborador");
    if (!employee) return { ok: false as const, error: "Código no encontrado" };
    if (!employee.active) return { ok: false as const, error: "Colaborador inactivo" };
    // Zone managers can clock in at any store assigned to them
    if (employee.role === "gerente_zona") {
      const { data: assign } = await supabaseAdmin
        .from("employee_store_assignments")
        .select("id")
        .eq("employee_id", employee.id)
        .eq("store_id", store.id)
        .maybeSingle();
      if (!assign)
        return { ok: false as const, error: `${store.name} no está asignada a este gerente de zona` };
    } else if (employee.store_id !== store.id) {
      return { ok: false as const, error: `Este colaborador no pertenece a ${store.name}` };
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

    // 3) Validate geofence (soft if store has no coords or client has no GPS)
    let locationValid = false;
    let distanceM: number | null = null;
    if (store.latitude != null && store.longitude != null && data.latitude != null && data.longitude != null) {
      distanceM = haversineMeters(store.latitude, store.longitude, data.latitude, data.longitude);
      locationValid = distanceM <= (store.geofence_radius_m ?? 300);
      if (!locationValid)
        return { ok: false as const, error: `Estás a ${Math.round(distanceM)}m de la tienda. Acércate (máx ${store.geofence_radius_m}m).` };
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
        notes: data.notes ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        location_accuracy_m: data.locationAccuracyM ?? null,
        location_valid: locationValid,
        auth_method: authMethod,
      });
    if (insErr) return { ok: false as const, error: "Error guardando marcaje" };

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
      .from("stores").select("id").eq("code", data.storeCode).maybeSingle();
    if (!store) return { found: false as const };
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, active, store_id, pin_hash, password_hash, username")
      .eq("employee_code", data.employeeCode)
      .maybeSingle();
    if (!emp || !emp.active) return { found: false as const };
    if (emp.role === "gerente_zona") {
      const { data: assign } = await supabaseAdmin
        .from("employee_store_assignments")
        .select("id")
        .eq("employee_id", emp.id)
        .eq("store_id", store.id)
        .maybeSingle();
      if (!assign) return { found: false as const, wrongStore: true as const };
    } else if (emp.store_id !== store.id) {
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