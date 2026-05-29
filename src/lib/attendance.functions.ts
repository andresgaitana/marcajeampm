import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyPin } from "./pin.server";

const markInput = z.object({
  employeeCode: z.string().trim().min(1).max(32),
  pin: z.string().trim().min(4).max(8),
  type: z.enum(["entrada", "salida"]),
  selfieDataUrl: z.string().min(20).max(8_000_000), // base64 data url
  notes: z.string().max(300).optional(),
});

/**
 * Public marcaje endpoint. Verifies PIN server-side, uploads selfie,
 * and creates an attendance record. Uses service role (no client auth needed).
 */
export const markAttendance = createServerFn({ method: "POST" })
  .inputValidator((input) => markInput.parse(input))
  .handler(async ({ data }) => {
    const { data: employee, error: empErr } = await supabaseAdmin
      .from("employees")
      .select("id, full_name, role, store, pin_hash, active")
      .eq("employee_code", data.employeeCode)
      .maybeSingle();

    if (empErr) throw new Error("Error consultando colaborador");
    if (!employee) return { ok: false as const, error: "Código no encontrado" };
    if (!employee.active) return { ok: false as const, error: "Colaborador inactivo" };
    if (!verifyPin(data.pin, employee.pin_hash)) {
      return { ok: false as const, error: "PIN incorrecto" };
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
        selfie_url: pub.publicUrl,
        notes: data.notes ?? null,
      });
    if (insErr) return { ok: false as const, error: "Error guardando marcaje" };

    return {
      ok: true as const,
      employee: {
        full_name: employee.full_name,
        role: employee.role,
        store: employee.store,
      },
      type: data.type,
      timestamp: new Date().toISOString(),
    };
  });

/**
 * Lookup employee name by code (no PIN). Used to give friendly
 * feedback ("Hola, María") before requesting the PIN.
 */
export const lookupEmployee = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ employeeCode: z.string().trim().min(1).max(32) }).parse(input))
  .handler(async ({ data }) => {
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("full_name, role, active")
      .eq("employee_code", data.employeeCode)
      .maybeSingle();
    if (!emp || !emp.active) return { found: false as const };
    return {
      found: true as const,
      full_name: emp.full_name,
      role: emp.role,
    };
  });