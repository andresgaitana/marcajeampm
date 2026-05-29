import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hashPin } from "./pin.server";

async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error("No se pudo verificar el rol");
  if (!data) throw new Error("Acceso denegado: se requiere rol de administrador");
}

export const checkAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    return { isAdmin: !!data };
  });

/** First-time bootstrap: if no admin exists, current user becomes admin. */
export const claimFirstAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) > 0) return { claimed: false as const, reason: "Ya existe un administrador" };
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: context.userId, role: "admin" });
    if (error) throw new Error(error.message);
    return { claimed: true as const };
  });

export const listEmployees = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id, employee_code, full_name, role, store, active, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const employeeInput = z.object({
  employee_code: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(["cajero", "gerente", "seguridad"]),
  store: z.string().trim().max(80).optional().nullable(),
  pin: z.string().trim().regex(/^\d{4,8}$/, "PIN debe ser 4-8 dígitos"),
  active: z.boolean().default(true),
});

export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => employeeInput.parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("employees").insert({
      employee_code: data.employee_code,
      full_name: data.full_name,
      role: data.role,
      store: data.store || null,
      pin_hash: hashPin(data.pin),
      active: data.active,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(120).optional(),
        role: z.enum(["cajero", "gerente", "seguridad"]).optional(),
        store: z.string().trim().max(80).nullable().optional(),
        active: z.boolean().optional(),
        pin: z.string().trim().regex(/^\d{4,8}$/).optional(),
      })
      .parse(i),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const patch: {
      full_name?: string;
      role?: "cajero" | "gerente" | "seguridad";
      store?: string | null;
      active?: boolean;
      pin_hash?: string;
    } = {};
    if (data.full_name !== undefined) patch.full_name = data.full_name;
    if (data.role !== undefined) patch.role = data.role;
    if (data.store !== undefined) patch.store = data.store;
    if (data.active !== undefined) patch.active = data.active;
    if (data.pin !== undefined) patch.pin_hash = hashPin(data.pin);
    const { error } = await supabaseAdmin.from("employees").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("employees").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAttendance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ limit: z.number().int().min(1).max(500).default(100) }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { data: rows, error } = await supabaseAdmin
      .from("attendance_records")
      .select("id, type, selfie_url, notes, created_at, employee:employees(id, full_name, employee_code, role, store)")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });