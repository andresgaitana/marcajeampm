import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hashPin } from "./pin.server";

/** Returns the set of roles the user has from public.user_roles. */
export async function getUserRoles(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r) => r.role as string);
}

export async function getAccessibleStoreIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("accessible_store_ids", { _user_id: userId });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { store_id: string }) => r.store_id);
}

export type AccessScope = {
  isAdmin: boolean;
  isOperations: boolean;
  isZoneAdmin: boolean;
  isStoreAdmin: boolean;
  storeIds: string[] | "all";
};

/** Returns access scope for current user. Throws if no admin-level access. */
export async function getScope(userId: string): Promise<AccessScope> {
  const roles = await getUserRoles(userId);
  const isAdmin = roles.includes("admin");
  const isOperations = roles.includes("gerente_operaciones");
  const isZoneAdmin = roles.includes("gerente_zona");
  const isStoreAdmin = roles.includes("gerente_tienda");
  // Backward-compat: a user with only store_managers rows still gets access.
  const ids = await getAccessibleStoreIds(userId);
  if (isAdmin || isOperations) return { isAdmin, isOperations, isZoneAdmin, isStoreAdmin, storeIds: "all" };
  if (ids.length === 0)
    throw new Error("Acceso denegado: tu cuenta no tiene tiendas asignadas");
  return { isAdmin, isOperations, isZoneAdmin, isStoreAdmin, storeIds: ids };
}

async function assertAdminOrOps(userId: string) {
  const roles = await getUserRoles(userId);
  if (!roles.includes("admin") && !roles.includes("gerente_operaciones"))
    throw new Error("Acceso denegado: solo Admin/Gerente de Operaciones");
}

async function assertSuperAdmin(userId: string) {
  const roles = await getUserRoles(userId);
  if (!roles.includes("admin")) throw new Error("Acceso denegado: solo Administrador");
}

export const checkAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const roles = await getUserRoles(context.userId);
    const isAdmin = roles.includes("admin");
    const isOperations = roles.includes("gerente_operaciones");
    const isZoneAdmin = roles.includes("gerente_zona");
    const isStoreAdmin = roles.includes("gerente_tienda");
    const ids = await getAccessibleStoreIds(context.userId);
    return {
      isAdmin,
      isOperations,
      isZoneAdmin,
      isStoreAdmin,
      // Backward compatibility for older callers
      isManager: !isAdmin && !isOperations && ids.length > 0,
      hasAccess: isAdmin || isOperations || ids.length > 0,
      storeIds: isAdmin || isOperations ? [] : ids,
    };
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
      .select("id, employee_code, full_name, role, store, store_id, active, username, created_at, must_change_pin, stores(code, name)")
      .order("created_at", { ascending: false });
    if (scope.storeIds !== "all") q = q.in("store_id", scope.storeIds);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const employeeInput = z.object({
  employee_code: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(["cajero", "gerente", "seguridad", "agente_mbk", "gerente_zona", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada"]),
  store_id: z.string().uuid(),
  pin: z.string().trim().regex(/^\d{4,8}$/, "PIN debe ser 4-8 dígitos"),
  face_descriptor: z.array(z.number()).length(128).optional(),
  active: z.boolean().default(true),
});

export const createEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => employeeInput.parse(i))
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (scope.storeIds !== "all" && !scope.storeIds.includes(data.store_id))
      throw new Error("No puedes crear colaboradores en esa tienda");
    // Un Gerente de Tienda (sin rol admin/ops/zona) solo puede crear
    // Cajero, Agente MBK o Seguridad. No puede crear Gerente ni Gerente de Zona.
    const isOnlyStoreAdmin =
      scope.isStoreAdmin && !scope.isAdmin && !scope.isOperations && !scope.isZoneAdmin;
    if (isOnlyStoreAdmin && !["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(data.role)) {
      throw new Error(
        "Como Gerente de Tienda solo puedes crear Agentes: Cajero, Agente MBK, Personal de Limpieza o Seguridad",
      );
    }
    const { error } = await supabaseAdmin.from("employees").insert({
      employee_code: data.employee_code,
      full_name: data.full_name,
      role: data.role,
      store_id: data.store_id,
      pin_hash: hashPin(data.pin),
      active: data.active,
      face_descriptor: data.face_descriptor ?? null,
      face_enrolled_at: data.face_descriptor ? new Date().toISOString() : null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// =====================================================================
// Admin Users (Operations and Zone managers) management
// =====================================================================

/** List users with admin-level roles (admin, operations, zone, store). */
export const listAdminUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdminOrOps(context.userId);
    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("id, user_id, role, created_at");
    const { data: zoneAssigns } = await supabaseAdmin
      .from("user_zone_assignments")
      .select("user_id, zone_id, zones(code, name)");
    const { data: storeAssigns } = await supabaseAdmin
      .from("store_managers")
      .select("user_id, store_id, stores(code, name)");

    const byUser = new Map<string, {
      user_id: string;
      email: string | null;
      roles: string[];
      zones: Array<{ id: string; code: string; name: string }>;
      stores: Array<{ id: string; code: string; name: string }>;
    }>();
    const ensure = (id: string) => {
      if (!byUser.has(id)) byUser.set(id, { user_id: id, email: null, roles: [], zones: [], stores: [] });
      return byUser.get(id)!;
    };
    for (const r of roles ?? []) ensure(r.user_id).roles.push(r.role as string);
    for (const z of zoneAssigns ?? []) {
      const zone = (z as { zones?: { code: string; name: string } | { code: string; name: string }[] }).zones;
      const obj = Array.isArray(zone) ? zone[0] : zone;
      ensure(z.user_id).zones.push({ id: z.zone_id, code: obj?.code ?? "", name: obj?.name ?? "" });
    }
    for (const s of storeAssigns ?? []) {
      const st = (s as { stores?: { code: string; name: string } | { code: string; name: string }[] }).stores;
      const obj = Array.isArray(st) ? st[0] : st;
      ensure(s.user_id).stores.push({ id: s.store_id, code: obj?.code ?? "", name: obj?.name ?? "" });
    }

    // Hydrate emails
    const result = Array.from(byUser.values());
    for (const u of result) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(u.user_id);
      u.email = data?.user?.email ?? null;
    }
    return result.sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
  });

const adminUserInput = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(72).optional(),
  role: z.enum(["admin", "gerente_operaciones", "gerente_tienda", "gerente_zona"]),
  store_ids: z.array(z.string().uuid()).max(500).optional(),
  zone_ids: z.array(z.string().uuid()).max(500).optional(),
});

/** Create/assign an admin user. Only admin can create other admins or operations. */
export const upsertAdminUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => adminUserInput.parse(i))
  .handler(async ({ context, data }) => {
    const roles = await getUserRoles(context.userId);
    const isAdmin = roles.includes("admin");
    const isOps = roles.includes("gerente_operaciones");
    if (!isAdmin && !isOps) throw new Error("Acceso denegado");
    // Only admin can create admin or operations users
    if ((data.role === "admin" || data.role === "gerente_operaciones") && !isAdmin)
      throw new Error("Solo Administrador puede crear este rol");

    // Find or create auth user by email
    let userId: string | null = null;
    let page = 1;
    while (page < 10) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      const found = list?.users?.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
      if (found) { userId = found.id; break; }
      if (!list?.users || list.users.length < 200) break;
      page++;
    }
    if (!userId) {
      if (!data.password) return { ok: false as const, error: "Usuario no existe. Define una contraseña inicial." };
      const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email: data.email, password: data.password, email_confirm: true,
      });
      if (error || !created.user) return { ok: false as const, error: error?.message ?? "No se pudo crear el usuario" };
      userId = created.user.id;
    }

    // Add role (idempotent)
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles").insert({ user_id: userId, role: data.role });
    if (roleErr && !roleErr.message.includes("duplicate") && !roleErr.message.includes("unique"))
      return { ok: false as const, error: roleErr.message };

    // Assign zones if zone admin
    if (data.role === "gerente_zona" && data.zone_ids && data.zone_ids.length > 0) {
      const rows = data.zone_ids.map((zone_id) => ({ user_id: userId!, zone_id }));
      await supabaseAdmin.from("user_zone_assignments").upsert(rows, { onConflict: "user_id,zone_id" });
    }
    // Assign stores if store admin
    if (data.role === "gerente_tienda" && data.store_ids && data.store_ids.length > 0) {
      const rows = data.store_ids.map((store_id) => ({ user_id: userId!, store_id }));
      await supabaseAdmin.from("store_managers").upsert(rows, { onConflict: "user_id,store_id" });
    }

    return { ok: true as const };
  });

/** Replace zone assignments for a user (admin/ops only). */
export const setUserZones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    user_id: z.string().uuid(),
    zone_ids: z.array(z.string().uuid()).max(500),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    await supabaseAdmin.from("user_zone_assignments").delete().eq("user_id", data.user_id);
    if (data.zone_ids.length > 0) {
      const rows = data.zone_ids.map((zone_id) => ({ user_id: data.user_id, zone_id }));
      const { error } = await supabaseAdmin.from("user_zone_assignments").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

/** Replace store assignments for a user (admin/ops only). */
export const setUserStores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    user_id: z.string().uuid(),
    store_ids: z.array(z.string().uuid()).max(500),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    await supabaseAdmin.from("store_managers").delete().eq("user_id", data.user_id);
    if (data.store_ids.length > 0) {
      const rows = data.store_ids.map((store_id) => ({ user_id: data.user_id, store_id }));
      const { error } = await supabaseAdmin.from("store_managers").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

/** Remove an admin user role (does not delete the auth user). */
export const removeAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    user_id: z.string().uuid(),
    role: z.enum(["admin", "gerente_operaciones", "gerente_tienda", "gerente_zona"]),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const roles = await getUserRoles(context.userId);
    const isAdmin = roles.includes("admin");
    const isOps = roles.includes("gerente_operaciones");
    if (!isAdmin && !isOps) throw new Error("Acceso denegado");
    if ((data.role === "admin" || data.role === "gerente_operaciones") && !isAdmin)
      throw new Error("Solo Administrador puede quitar este rol");
    if (data.role === "admin" && data.user_id === context.userId)
      throw new Error("No puedes quitarte el rol de Administrador a ti mismo");
    await supabaseAdmin.from("user_roles").delete()
      .eq("user_id", data.user_id).eq("role", data.role);
    if (data.role === "gerente_zona")
      await supabaseAdmin.from("user_zone_assignments").delete().eq("user_id", data.user_id);
    if (data.role === "gerente_tienda")
      await supabaseAdmin.from("store_managers").delete().eq("user_id", data.user_id);
    return { ok: true };
  });

export const updateEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid(),
        full_name: z.string().trim().min(1).max(120).optional(),
        role: z.enum(["cajero", "gerente", "seguridad", "agente_mbk", "gerente_zona", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada"]).optional(),
        store_id: z.string().uuid().optional(),
        active: z.boolean().optional(),
        pin: z.string().trim().regex(/^\d{4,8}$/).optional(),
        face_descriptor: z.array(z.number()).length(128).optional(),
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
      role?: "cajero" | "gerente" | "seguridad" | "agente_mbk" | "gerente_zona" | "personal_limpieza" | "seguridad_interna" | "seguridad_tercerizada";
      store_id?: string;
      active?: boolean;
      pin_hash?: string;
      face_descriptor?: number[];
      face_enrolled_at?: string;
    } = {};
    if (data.full_name !== undefined) patch.full_name = data.full_name;
    if (data.role !== undefined) patch.role = data.role;
    if (data.store_id !== undefined) patch.store_id = data.store_id;
    if (data.active !== undefined) patch.active = data.active;
    if (data.pin !== undefined) patch.pin_hash = hashPin(data.pin);
    if (data.face_descriptor) {
      patch.face_descriptor = data.face_descriptor;
      patch.face_enrolled_at = new Date().toISOString();
    }
    const { error } = await supabaseAdmin.from("employees").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Restablece el PIN de marcaje de un colaborador a 1234 y lo marca para que
 * deba cambiarlo en su primer marcaje (must_change_pin). Jerarquía:
 *  - Gerente de Tienda: solo a sus Agentes (cajero / agente_mbk / seguridad).
 *  - Gerente de Zona: a sus Gerentes de Tienda y Agentes de su zona (no a otro GZ).
 *  - Super admin / Gerente de Operaciones: a cualquier nivel.
 */
export const resetEmployeePin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const { data: emp } = await supabaseAdmin
      .from("employees").select("store_id, role").eq("id", data.id).maybeSingle();
    if (!emp) throw new Error("Colaborador no encontrado");
    // El colaborador debe estar dentro del alcance de tiendas del usuario.
    if (scope.storeIds !== "all" && !scope.storeIds.includes(emp.store_id))
      throw new Error("No puedes restablecer el PIN de este colaborador");

    const isSuper = scope.isAdmin || scope.isOperations;
    const isZoneOnly = scope.isZoneAdmin && !isSuper;
    const isStoreOnly = scope.isStoreAdmin && !isSuper && !scope.isZoneAdmin;
    if (isStoreOnly && !["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(emp.role))
      throw new Error("Como Gerente de Tienda solo puedes restablecer el PIN de tus Agentes (Cajero, MBK, Limpieza, Seguridad).");
    if (isZoneOnly && emp.role === "gerente_zona")
      throw new Error("No puedes restablecer el PIN de otro Gerente de Zona.");

    const { error } = await supabaseAdmin.from("employees")
      .update({ pin_hash: hashPin("1234"), must_change_pin: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const deleteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const isOnlyStoreAdmin =
      scope.isStoreAdmin && !scope.isAdmin && !scope.isOperations && !scope.isZoneAdmin;
    const { data: current } = await supabaseAdmin
      .from("employees").select("store_id, role").eq("id", data.id).maybeSingle();
    if (!current) throw new Error("Colaborador no encontrado");
    if (scope.storeIds !== "all" && !scope.storeIds.includes(current.store_id))
      throw new Error("No puedes eliminar este colaborador");
    // Un Gerente de Tienda solo puede eliminar Cajero, Agente MBK o Seguridad de su tienda
    // (no a otros gerentes ni gerentes de zona).
    if (isOnlyStoreAdmin && !["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(current.role)) {
      throw new Error(
        "Como Gerente de Tienda solo puedes eliminar Agentes: Cajero, Agente MBK, Personal de Limpieza o Seguridad",
      );
    }
    const { error } = await supabaseAdmin.from("employees").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// =====================================================================
// Seed: 10 Gerentes de Zona (admin login + employee record + zone link)
// =====================================================================

const GZ_SEED: Array<{ email: string; name: string; zoneCode: string; code: string }> = [
  { email: "carlos.sandoval@ampm.com.ni",    name: "Carlos Sandoval",     zoneCode: "MGA_SUR",      code: "GZ01" },
  { email: "cristina.maldonado@ampm.com.ni", name: "Cristina Maldonado",  zoneCode: "MGA_CENTRO",   code: "GZ02" },
  { email: "erica.zamora@ampm.com.ni",       name: "Erica Zamora",        zoneCode: "MGA_NORTE",    code: "GZ03" },
  { email: "engels.castellon@ampm.com.ni",   name: "Engels Castellon",    zoneCode: "MGA_NORESTE",  code: "GZ04" },
  { email: "daniel.centeno@ampm.com.ni",     name: "Daniel Centeno",      zoneCode: "FOR_S1",       code: "GZ05" },
  { email: "marcos.munoz@ampm.com.ni",       name: "Marcos Zarate",       zoneCode: "FOR_OCCIDENTE",code: "GZ06" },
  { email: "tania.ruiz@ampm.com.ni",         name: "Tania Ruiz",          zoneCode: "FOR_NORTE",    code: "GZ07" },
  { email: "cristhian.guzman@ampm.com.ni",   name: "Cristhian Guzman",    zoneCode: "FOR_S2",       code: "GZ08" },
  { email: "julio.gutierrez@ampm.com.ni",    name: "Julio Gutierrez",     zoneCode: "FOR_CENTRO_2", code: "GZ09" },
  { email: "yuri.reyes@ampm.com.ni",         name: "Yuri Reyes",          zoneCode: "FOR_CENTRO_1", code: "GZ10" },
];

/** Find an auth user by email by paginating listUsers. */
async function findAuthUserId(email: string): Promise<string | null> {
  let page = 1;
  while (page < 20) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    const found = list?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (!list?.users || list.users.length < 200) return null;
    page++;
  }
  return null;
}

/**
 * Idempotent: creates/updates the 10 Gerentes de Zona.
 * - auth user (password Cambiar123! if new)
 * - role gerente_zona
 * - zone assignment in user_zone_assignments
 * - employee record with PIN 0000, role gerente_zona, anchored to first store of the zone
 * - employee_store_assignments with every store of the zone
 */
export const seedZoneManagers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const pinHash = hashPin("0000");
    const results: Array<{ email: string; status: string; error?: string }> = [];

    for (const gz of GZ_SEED) {
      try {
        // 1) Resolve zone
        const { data: zone } = await supabaseAdmin
          .from("zones").select("id").eq("code", gz.zoneCode).maybeSingle();
        if (!zone) { results.push({ email: gz.email, status: "skip", error: `zona ${gz.zoneCode} no existe` }); continue; }

        // 2) Stores of that zone
        const { data: zoneStores } = await supabaseAdmin
          .from("stores").select("id, code").eq("zone_id", zone.id).order("code");
        if (!zoneStores || zoneStores.length === 0) {
          results.push({ email: gz.email, status: "skip", error: `zona ${gz.zoneCode} sin tiendas` }); continue;
        }
        const anchorStoreId = zoneStores[0].id;

        // 3) Find or create auth user
        let userId = await findAuthUserId(gz.email);
        if (!userId) {
          const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
            email: gz.email, password: "Cambiar123!", email_confirm: true,
          });
          if (cErr || !created.user) { results.push({ email: gz.email, status: "error", error: cErr?.message ?? "no se creó" }); continue; }
          userId = created.user.id;
        }

        // 4) Role gerente_zona (idempotent)
        await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "gerente_zona" })
          .then(({ error }) => { if (error && !error.message.match(/duplicate|unique/i)) throw new Error(error.message); });

        // 5) Zone assignment
        await supabaseAdmin.from("user_zone_assignments")
          .upsert({ user_id: userId, zone_id: zone.id }, { onConflict: "user_id,zone_id" });

        // 6) Employee record (upsert by employee_code)
        const { data: existingEmp } = await supabaseAdmin
          .from("employees").select("id").eq("employee_code", gz.code).maybeSingle();
        let employeeId: string;
        if (existingEmp) {
          await supabaseAdmin.from("employees").update({
            full_name: gz.name, role: "gerente_zona", store_id: anchorStoreId, active: true,
          }).eq("id", existingEmp.id);
          employeeId = existingEmp.id;
        } else {
          const { data: newEmp, error: eErr } = await supabaseAdmin.from("employees").insert({
            employee_code: gz.code, full_name: gz.name, role: "gerente_zona",
            store_id: anchorStoreId, pin_hash: pinHash, active: true,
          }).select("id").single();
          if (eErr || !newEmp) { results.push({ email: gz.email, status: "error", error: eErr?.message ?? "no se creó empleado" }); continue; }
          employeeId = newEmp.id;
        }

        // 7) Store assignments = all stores of the zone
        await supabaseAdmin.from("employee_store_assignments").delete().eq("employee_id", employeeId);
        const rows = zoneStores.map((s) => ({ employee_id: employeeId, store_id: s.id }));
        await supabaseAdmin.from("employee_store_assignments").insert(rows);

        results.push({ email: gz.email, status: "ok" });
      } catch (e) {
        results.push({ email: gz.email, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results };
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

/** List store assignments for an employee (used for Gerente de Zona). */
export const listEmployeeAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ employee_id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    // Evitar lectura cruzada: el colaborador debe pertenecer al scope del usuario.
    if (scope.storeIds !== "all") {
      const { data: emp } = await supabaseAdmin
        .from("employees").select("store_id").eq("id", data.employee_id).maybeSingle();
      if (!emp || !scope.storeIds.includes(emp.store_id))
        throw new Error("Acceso denegado a este colaborador");
    }
    const { data: rows, error } = await supabaseAdmin
      .from("employee_store_assignments")
      .select("store_id, stores(code, name)")
      .eq("employee_id", data.employee_id);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Replace the set of stores assigned to an employee. */
export const setEmployeeAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      employee_id: z.string().uuid(),
      store_ids: z.array(z.string().uuid()).max(200),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (scope.storeIds !== "all") {
      const allowed = new Set(scope.storeIds);
      for (const id of data.store_ids)
        if (!allowed.has(id)) throw new Error("No puedes asignar tiendas fuera de tu alcance");
    }
    const { error: delErr } = await supabaseAdmin
      .from("employee_store_assignments")
      .delete()
      .eq("employee_id", data.employee_id);
    if (delErr) throw new Error(delErr.message);
    if (data.store_ids.length > 0) {
      const rows = data.store_ids.map((store_id) => ({ employee_id: data.employee_id, store_id }));
      const { error: insErr } = await supabaseAdmin.from("employee_store_assignments").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    return { ok: true };
  });

// =====================================================================
// Seed: Gerente de Operaciones (Marco Lopez)
// =====================================================================

/** Idempotent: provisions Marco Lopez as Gerente de Operaciones. */
export const seedOperationsManager = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const email = "marco.lopez@ampmcentroamerica.com";
    const name = "Marco Lopez";
    try {
      let userId = await findAuthUserId(email);
      if (!userId) {
        const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
          email, password: "Cambiar123!", email_confirm: true,
          user_metadata: { full_name: name },
        });
        if (cErr || !created.user) return { ok: false as const, error: cErr?.message ?? "no se pudo crear" };
        userId = created.user.id;
      }
      const { error: rErr } = await supabaseAdmin
        .from("user_roles").insert({ user_id: userId, role: "gerente_operaciones" });
      if (rErr && !rErr.message.match(/duplicate|unique/i))
        return { ok: false as const, error: rErr.message };
      return { ok: true as const, email, password: "Cambiar123!" };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

// =====================================================================
// Seed: Super Admins adicionales (RRHH y Gerente de País)
// =====================================================================
const EXTRA_SUPER_ADMINS: Array<{ email: string; name: string }> = [
  { email: "vilma.berrios@ampmcentroamerica.com", name: "Vilma Berrios" },
  { email: "rodolfo.castillo@ampmcentroamerica.com", name: "Rodolfo Castillo" },
];

export const seedExtraSuperAdmins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const results: Array<{ email: string; status: "ok" | "error"; error?: string }> = [];
    for (const u of EXTRA_SUPER_ADMINS) {
      try {
        let userId = await findAuthUserId(u.email);
        if (!userId) {
          const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
            email: u.email, password: "Cambiar123!", email_confirm: true,
            user_metadata: { full_name: u.name },
          });
          if (cErr || !created.user) { results.push({ email: u.email, status: "error", error: cErr?.message ?? "no se pudo crear" }); continue; }
          userId = created.user.id;
        }
        const { error: rErr } = await supabaseAdmin
          .from("user_roles").insert({ user_id: userId, role: "admin" });
        if (rErr && !rErr.message.match(/duplicate|unique/i)) {
          results.push({ email: u.email, status: "error", error: rErr.message }); continue;
        }
        results.push({ email: u.email, status: "ok" });
      } catch (e) {
        results.push({ email: u.email, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results, password: "Cambiar123!" };
  });

// =====================================================================
// Seed: Gerentes de Tienda (GT) — 1 GT por tienda, con email genérico
// Carga lista oficial de Contacto_GT-GZ.xlsx (zonas + correos por tienda)
// =====================================================================

const GT_SEED: Array<{ storeCode: string; zoneCode: string; gtEmail: string }> = [
  { storeCode: "A01", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm01@ampm.com.ni" },
  { storeCode: "A02", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm02@ampm.com.ni" },
  { storeCode: "A03", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm03@ampm.com.ni" },
  { storeCode: "A04", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm04@ampm.com.ni" },
  { storeCode: "A05", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm05@ampm.com.ni" },
  { storeCode: "A06", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm06@ampm.com.ni" },
  { storeCode: "A07", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm07@ampm.com.ni" },
  { storeCode: "A08", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm08@ampm.com.ni" },
  { storeCode: "A09", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm09@ampm.com.ni" },
  { storeCode: "A10", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm10@ampm.com.ni" },
  { storeCode: "A12", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm12@ampm.com.ni" },
  { storeCode: "A13", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm13@ampm.com.ni" },
  { storeCode: "A14", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm14@ampm.com.ni" },
  { storeCode: "A15", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm15@ampm.com.ni" },
  { storeCode: "A16", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm16@ampm.com.ni" },
  { storeCode: "A18", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm18@ampm.com.ni" },
  { storeCode: "A19", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm19@ampm.com.ni" },
  { storeCode: "A20", zoneCode: "FOR_S1", gtEmail: "jefe.ampm20@ampm.com.ni" },
  { storeCode: "A21", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm21@ampm.com.ni" },
  { storeCode: "A23", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm23@ampm.com.ni" },
  { storeCode: "A25", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm25@ampm.com.ni" },
  { storeCode: "A26", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm26@ampm.com.ni" },
  { storeCode: "A27", zoneCode: "FOR_S1", gtEmail: "jefe.ampm27@ampm.com.ni" },
  { storeCode: "A28", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm28@ampm.com.ni" },
  { storeCode: "A29", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm29@ampm.com.ni" },
  { storeCode: "A30", zoneCode: "FOR_S2", gtEmail: "jefe.ampm30@ampm.com.ni" },
  { storeCode: "A31", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm31@ampm.com.ni" },
  { storeCode: "A32", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm32@ampm.com.ni" },
  { storeCode: "A33", zoneCode: "FOR_S1", gtEmail: "jefe.ampm33@ampm.com.ni" },
  { storeCode: "A34", zoneCode: "FOR_S1", gtEmail: "jefe.ampm34@ampm.com.ni" },
  { storeCode: "A35", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm35@ampm.com.ni" },
  { storeCode: "A36", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm36@ampm.com.ni" },
  { storeCode: "A37", zoneCode: "FOR_S2", gtEmail: "jefe.ampm37@ampm.com.ni" },
  { storeCode: "A38", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm38@ampm.com.ni" },
  { storeCode: "A39", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm39@ampm.com.ni" },
  { storeCode: "A40", zoneCode: "FOR_S2", gtEmail: "jefe.ampm40@ampm.com.ni" },
  { storeCode: "A41", zoneCode: "FOR_S2", gtEmail: "jefe.ampm41@ampm.com.ni" },
  { storeCode: "A42", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm42@ampm.com.ni" },
  { storeCode: "A43", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm43@ampm.com.ni" },
  { storeCode: "A44", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm44@ampm.com.ni" },
  { storeCode: "A45", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm45@ampm.com.ni" },
  { storeCode: "A46", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm46@ampm.com.ni" },
  { storeCode: "A47", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm47@ampm.com.ni" },
  { storeCode: "A48", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm48@ampm.com.ni" },
  { storeCode: "A49", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm49@ampm.com.ni" },
  { storeCode: "A50", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm50@ampm.com.ni" },
  { storeCode: "A51", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm51@ampm.com.ni" },
  { storeCode: "A52", zoneCode: "FOR_S1", gtEmail: "jefe.ampm52@ampm.com.ni" },
  { storeCode: "A53", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm53@ampm.com.ni" },
  { storeCode: "A54", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm54@ampm.com.ni" },
  { storeCode: "A55", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm55@ampm.com.ni" },
  { storeCode: "A56", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm56@ampm.com.ni" },
  { storeCode: "A57", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm57@ampm.com.ni" },
  { storeCode: "A58", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm58@ampm.com.ni" },
  { storeCode: "A59", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm59@ampm.com.ni" },
  { storeCode: "A60", zoneCode: "FOR_S2", gtEmail: "jefe.ampm60@ampm.com.ni" },
  { storeCode: "A61", zoneCode: "FOR_S2", gtEmail: "jefe.ampm61@ampm.com.ni" },
  { storeCode: "A62", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm62@ampm.com.ni" },
  { storeCode: "A63", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm63@ampm.com.ni" },
  { storeCode: "A64", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm64@ampm.com.ni" },
  { storeCode: "A65", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm65@ampm.com.ni" },
  { storeCode: "A66", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm66@ampm.com.ni" },
  { storeCode: "A67", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm67@ampm.com.ni" },
  { storeCode: "A68", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm68@ampm.com.ni" },
  { storeCode: "A69", zoneCode: "MGA_CENTRO", gtEmail: "jefe.ampm69@ampm.com.ni" },
  { storeCode: "A70", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm70@ampm.com.ni" },
  { storeCode: "A71", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm71@ampm.com.ni" },
  { storeCode: "A72", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm72@ampm.com.ni" },
  { storeCode: "A73", zoneCode: "FOR_S1", gtEmail: "jefe.ampm73@ampm.com.ni" },
  { storeCode: "A74", zoneCode: "FOR_S1", gtEmail: "jefe.ampm74@ampm.com.ni" },
  { storeCode: "A75", zoneCode: "FOR_S1", gtEmail: "jefe.ampm75@ampm.com.ni" },
  { storeCode: "A76", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm76@ampm.com.ni" },
  { storeCode: "A77", zoneCode: "FOR_NORTE", gtEmail: "jefe.ampm77@ampm.com.ni" },
  { storeCode: "A78", zoneCode: "FOR_S1", gtEmail: "jefe.ampm78@ampm.com.ni" },
  { storeCode: "A79", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm79@ampm.com.ni" },
  { storeCode: "A80", zoneCode: "FOR_CENTRO_2", gtEmail: "jefe.ampm80@ampm.com.ni" },
  { storeCode: "A81", zoneCode: "MGA_NORTE", gtEmail: "jefe.ampm81@ampm.com.ni" },
  { storeCode: "A82", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm82@ampm.com.ni" },
  { storeCode: "A83", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm83@ampm.com.ni" },
  { storeCode: "A84", zoneCode: "FOR_S2", gtEmail: "jefe.ampm84@ampm.com.ni" },
  { storeCode: "A85", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm85@ampm.com.ni" },
  { storeCode: "A86", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm86@ampm.com.ni" },
  { storeCode: "A87", zoneCode: "FOR_CENTRO_1", gtEmail: "jefe.ampm87@ampm.com.ni" },
  { storeCode: "A88", zoneCode: "MGA_NORESTE", gtEmail: "jefe.ampm88@ampm.com.ni" },
  { storeCode: "A89", zoneCode: "FOR_S1", gtEmail: "jefe.ampm89@ampm.com.ni" },
  { storeCode: "A90", zoneCode: "FOR_OCCIDENTE", gtEmail: "jefe.ampm90@ampm.com.ni" },
  { storeCode: "A91", zoneCode: "MGA_SUR", gtEmail: "jefe.ampm91@ampm.com.ni" },
];

/**
 * Idempotent: por cada tienda en GT_SEED,
 *  1) corrige stores.zone_id según el archivo,
 *  2) crea (si no existe) el usuario auth del GT con password Cambiar123!,
 *  3) asigna rol gerente_tienda (idempotente),
 *  4) hace upsert en store_managers (user_id, store_id).
 */
export const seedStoreManagers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);

    // Pre-cargar zonas y tiendas
    const { data: zones } = await supabaseAdmin.from("zones").select("id, code");
    const zoneByCode = new Map((zones ?? []).map((z) => [z.code, z.id as string]));
    const { data: stores } = await supabaseAdmin.from("stores").select("id, code, zone_id");
    const storeByCode = new Map((stores ?? []).map((s) => [s.code, s]));

    // Cache GT email -> user_id para no recrear duplicados
    const userByEmail = new Map<string, string>();

    const results: Array<{ storeCode: string; status: string; error?: string }> = [];

    for (const it of GT_SEED) {
      try {
        const store = storeByCode.get(it.storeCode);
        if (!store) { results.push({ storeCode: it.storeCode, status: "skip", error: "tienda no existe" }); continue; }
        const zoneId = zoneByCode.get(it.zoneCode);
        if (!zoneId) { results.push({ storeCode: it.storeCode, status: "skip", error: `zona ${it.zoneCode} no existe` }); continue; }

        // 1) Update zone_id si difiere
        if (store.zone_id !== zoneId) {
          const { error: uErr } = await supabaseAdmin.from("stores")
            .update({ zone_id: zoneId }).eq("id", store.id);
          if (uErr) throw new Error("zona: " + uErr.message);
        }

        // 2) Auth user GT
        let userId = userByEmail.get(it.gtEmail) ?? null;
        if (!userId) userId = await findAuthUserId(it.gtEmail);
        if (!userId) {
          const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
            email: it.gtEmail, password: "Cambiar123!", email_confirm: true,
          });
          if (cErr || !created.user) throw new Error("auth: " + (cErr?.message ?? "no se creó"));
          userId = created.user.id;
        }
        userByEmail.set(it.gtEmail, userId);

        // 3) Rol gerente_tienda (idempotente)
        const { error: rErr } = await supabaseAdmin.from("user_roles")
          .insert({ user_id: userId, role: "gerente_tienda" });
        if (rErr && !rErr.message.match(/duplicate|unique/i)) throw new Error("rol: " + rErr.message);

        // 4) store_managers (idempotente)
        const { error: smErr } = await supabaseAdmin.from("store_managers")
          .upsert({ user_id: userId, store_id: store.id }, { onConflict: "user_id,store_id" });
        if (smErr) throw new Error("store_managers: " + smErr.message);

        // 5) employees (colaborador "Gerente de Tienda" para que pueda marcar asistencia)
        const empCode = `GT-${it.storeCode}`;
        const { data: existingEmp } = await supabaseAdmin
          .from("employees").select("id").eq("employee_code", empCode).maybeSingle();
        let employeeId = existingEmp?.id as string | undefined;
        if (!employeeId) {
          const { data: emp, error: eErr } = await supabaseAdmin.from("employees")
            .insert({
              employee_code: empCode,
              full_name: `Gerente Tienda ${it.storeCode}`,
              role: "gerente",
              store_id: store.id,
              pin_hash: hashPin("1234"),
              active: true,
            })
            .select("id").single();
          if (eErr) throw new Error("employees: " + eErr.message);
          employeeId = emp.id;
        } else {
          // Mantener tienda principal sincronizada
          await supabaseAdmin.from("employees")
            .update({ store_id: store.id, active: true }).eq("id", employeeId);
        }

        // 6) employee_store_assignments (idempotente)
        const { error: esaErr } = await supabaseAdmin.from("employee_store_assignments")
          .upsert({ employee_id: employeeId, store_id: store.id }, { onConflict: "employee_id,store_id" });
        if (esaErr) throw new Error("employee_store_assignments: " + esaErr.message);

        results.push({ storeCode: it.storeCode, status: "ok" });
      } catch (e) {
        results.push({ storeCode: it.storeCode, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results };
  });