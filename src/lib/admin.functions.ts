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

async function getManagerStoreIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("store_managers")
    .select("store_id")
    .eq("user_id", userId);
  if (error) throw new Error("No se pudieron cargar tiendas asignadas");
  return (data ?? []).map((r) => r.store_id);
}

async function isAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
}

/** Returns access scope for current user: admin (all stores) or manager (subset). */
async function getScope(userId: string): Promise<{ isAdmin: boolean; storeIds: string[] | "all" }> {
  if (await isAdmin(userId)) return { isAdmin: true, storeIds: "all" };
  const ids = await getManagerStoreIds(userId);
  if (ids.length === 0) throw new Error("Acceso denegado: tu cuenta no tiene tiendas asignadas");
  return { isAdmin: false, storeIds: ids };
}

export const checkAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await isAdmin(context.userId);
    const storeIds = admin ? [] : await getManagerStoreIds(context.userId);
    return { isAdmin: admin, isManager: !admin && storeIds.length > 0, storeIds };
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
    const scope = await getScope(context.userId);
    let q = supabaseAdmin
      .from("employees")
      .select("id, employee_code, full_name, role, store, store_id, active, username, created_at, stores(code, name)")
      .order("created_at", { ascending: false });
    if (scope.storeIds !== "all") q = q.in("store_id", scope.storeIds);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const employeeInput = z.object({
  employee_code: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(["cajero", "gerente", "seguridad"]),
  store_id: z.string().uuid(),
  pin: z.string().trim().regex(/^\d{4,8}$/, "PIN debe ser 4-8 dígitos"),
  active: z.boolean().default(true),
});

export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => employeeInput.parse(i))
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (scope.storeIds !== "all" && !scope.storeIds.includes(data.store_id))
      throw new Error("No puedes crear colaboradores en esa tienda");
    const { error } = await supabaseAdmin.from("employees").insert({
      employee_code: data.employee_code,
      full_name: data.full_name,
      role: data.role,
      store_id: data.store_id,
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
        store_id: z.string().uuid().optional(),
        active: z.boolean().optional(),
        pin: z.string().trim().regex(/^\d{4,8}$/).optional(),
      })
      .parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    // Verify current store is in scope
    const { data: current } = await supabaseAdmin
      .from("employees").select("store_id").eq("id", data.id).maybeSingle();
    if (!current) throw new Error("Colaborador no encontrado");
    if (scope.storeIds !== "all" && !scope.storeIds.includes(current.store_id))
      throw new Error("No puedes editar este colaborador");
    if (data.store_id && scope.storeIds !== "all" && !scope.storeIds.includes(data.store_id))
      throw new Error("No puedes mover el colaborador a esa tienda");
    const patch: {
      full_name?: string;
      role?: "cajero" | "gerente" | "seguridad";
      store_id?: string;
      active?: boolean;
      pin_hash?: string;
    } = {};
    if (data.full_name !== undefined) patch.full_name = data.full_name;
    if (data.role !== undefined) patch.role = data.role;
    if (data.store_id !== undefined) patch.store_id = data.store_id;
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
    const scope = await getScope(context.userId);
    const { data: current } = await supabaseAdmin
      .from("employees").select("store_id").eq("id", data.id).maybeSingle();
    if (!current) throw new Error("Colaborador no encontrado");
    if (scope.storeIds !== "all" && !scope.storeIds.includes(current.store_id))
      throw new Error("No puedes eliminar este colaborador");
    const { error } = await supabaseAdmin.from("employees").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAttendance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      limit: z.number().int().min(1).max(1000).default(200),
      storeId: z.string().uuid().optional(),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    let q = supabaseAdmin
      .from("attendance_records")
      .select("id, type, selfie_url, notes, created_at, store_id, employee:employees(id, full_name, employee_code, role), store:stores(code, name)")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.storeId) q = q.eq("store_id", data.storeId);
    if (scope.storeIds !== "all") q = q.in("store_id", scope.storeIds);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });