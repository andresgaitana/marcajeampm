import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hashPin } from "./pin.server";

async function assertAdminOrOps(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId)
    .in("role", ["admin", "gerente_operaciones"]);
  if (!data || data.length === 0)
    throw new Error("Acceso denegado: solo Admin/Gerente de Operaciones");
}

/**
 * Admin/Ops always allowed; GZ allowed if the store belongs to a zone assigned to them.
 * Used for GT (store_managers) management — GZ can add/remove GT in their own zone.
 */
async function assertCanManageStore(userId: string, storeId: string) {
  const { data: roles } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId);
  const set = new Set((roles ?? []).map((r) => r.role as string));
  if (set.has("admin") || set.has("gerente_operaciones")) return;
  if (set.has("gerente_zona")) {
    const { data: store } = await supabaseAdmin
      .from("stores").select("zone_id").eq("id", storeId).maybeSingle();
    if (!store?.zone_id) throw new Error("Tienda sin zona asignada");
    const { data: assign } = await supabaseAdmin
      .from("user_zone_assignments").select("zone_id")
      .eq("user_id", userId).eq("zone_id", store.zone_id).maybeSingle();
    if (assign) return;
  }
  throw new Error("Acceso denegado: la tienda no pertenece a tu zona");
}

/** List stores: admin sees all, manager sees only assigned. */
export const listStores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roles } = await supabaseAdmin
      .from("user_roles").select("role").eq("user_id", context.userId);
    const roleSet = new Set((roles ?? []).map((r) => r.role as string));
    if (roleSet.has("admin") || roleSet.has("gerente_operaciones")) {
      const { data, error } = await supabaseAdmin
        .from("stores")
        .select("id, code, name, address, latitude, longitude, geofence_radius_m, active, zone_id, created_at, zones(code, name)")
        .order("code", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    }
    // Use accessible_store_ids for zone/store admins
    const { data: idRows } = await supabaseAdmin.rpc("accessible_store_ids", { _user_id: context.userId });
    const ids = (idRows ?? []).map((r: { store_id: string }) => r.store_id);
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from("stores")
      .select("id, code, name, address, latitude, longitude, geofence_radius_m, active, zone_id, created_at, zones(code, name)")
      .in("id", ids)
      .order("code", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const storeInput = z.object({
  code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(255).optional().nullable(),
  terminal_pin: z.string().trim().regex(/^\d{4,8}$/, "PIN debe ser 4-8 dígitos"),
  active: z.boolean().default(true),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  geofence_radius_m: z.number().int().min(20).max(5000).optional(),
  zone_id: z.string().uuid().nullable().optional(),
});

export const createStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => storeInput.parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const { error } = await supabaseAdmin.from("stores").insert({
      code: data.code.toUpperCase(),
      name: data.name,
      address: data.address || null,
      terminal_pin_hash: hashPin(data.terminal_pin),
      active: data.active,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      geofence_radius_m: data.geofence_radius_m ?? 300,
      zone_id: data.zone_id ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Bulk create stores. Useful for seeding A01..A95 or support areas. */
export const bulkCreateStores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      items: z.array(z.object({
        code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/),
        name: z.string().trim().min(1).max(120),
      })).min(1).max(500),
      terminal_pin: z.string().trim().regex(/^\d{4,8}$/),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const pinHash = hashPin(data.terminal_pin);
    const rows = data.items.map((it) => ({
      code: it.code.toUpperCase(),
      name: it.name,
      terminal_pin_hash: pinHash,
      active: true,
    }));
    // upsert by code to be idempotent
    const { data: existing } = await supabaseAdmin
      .from("stores").select("code").in("code", rows.map((r) => r.code));
    const existingCodes = new Set((existing ?? []).map((r) => r.code));
    const toInsert = rows.filter((r) => !existingCodes.has(r.code));
    if (toInsert.length === 0) return { created: 0, skipped: rows.length };
    const { error } = await supabaseAdmin.from("stores").insert(toInsert);
    if (error) throw new Error(error.message);
    return { created: toInsert.length, skipped: rows.length - toInsert.length };
  });

export const updateStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    id: z.string().uuid(),
    name: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().min(1).max(120).optional()),
    address: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(255).nullable().optional()),
    terminal_pin: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().regex(/^\d{4,8}$/).optional()),
    active: z.boolean().optional(),
    latitude: z.preprocess((v) => (v === "" || v === null ? null : v), z.number().min(-90).max(90).nullable().optional()),
    longitude: z.preprocess((v) => (v === "" || v === null ? null : v), z.number().min(-180).max(180).nullable().optional()),
    geofence_radius_m: z.number().int().min(20).max(5000).optional(),
    zone_id: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable().optional()),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const patch: {
      name?: string;
      address?: string | null;
      active?: boolean;
      terminal_pin_hash?: string;
      latitude?: number | null;
      longitude?: number | null;
      geofence_radius_m?: number;
      zone_id?: string | null;
    } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.address !== undefined) patch.address = data.address;
    if (data.active !== undefined) patch.active = data.active;
    if (data.terminal_pin !== undefined) patch.terminal_pin_hash = hashPin(data.terminal_pin);
    if (data.latitude !== undefined) patch.latitude = data.latitude;
    if (data.longitude !== undefined) patch.longitude = data.longitude;
    if (data.geofence_radius_m !== undefined) patch.geofence_radius_m = data.geofence_radius_m;
    if (data.zone_id !== undefined) patch.zone_id = data.zone_id;
    const { error } = await supabaseAdmin.from("stores").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const { error } = await supabaseAdmin.from("stores").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Cambiar SOLO el PIN de terminal de una tienda. Permitido a Super admin (todas)
 * y al Gerente de Zona en las tiendas de SU zona. No toca el resto de la config.
 */
export const setStoreTerminalPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      terminal_pin: z.string().trim().regex(/^\d{4,8}$/, "PIN debe ser 4-8 dígitos"),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    await assertCanManageStore(context.userId, data.storeId);
    const { error } = await supabaseAdmin
      .from("stores")
      .update({ terminal_pin_hash: hashPin(data.terminal_pin) })
      .eq("id", data.storeId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/**
 * Reiniciar la contraseña de login (panel) del/los Gerente(s) de Tienda de una
 * tienda. Permitido a Super admin (cualquiera) y al GZ en su zona. Solo afecta a
 * usuarios con rol gerente_tienda (no toca admins ni GZ). Devuelve una contraseña
 * temporal para entregar al GT.
 */
export const resetManagerPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ storeId: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertCanManageStore(context.userId, data.storeId);
    const { data: mgrs } = await supabaseAdmin
      .from("store_managers").select("user_id").eq("store_id", data.storeId);
    const userIds = [...new Set((mgrs ?? []).map((m) => m.user_id as string))];
    if (userIds.length === 0)
      return { ok: false as const, error: "Esta tienda no tiene Gerente de Tienda con acceso al panel." };
    // Solo usuarios con rol gerente_tienda (no admin/ops/gz).
    const { data: roleRows } = await supabaseAdmin
      .from("user_roles").select("user_id").in("user_id", userIds).eq("role", "gerente_tienda");
    const gtIds = [...new Set((roleRows ?? []).map((r) => r.user_id as string))];
    if (gtIds.length === 0)
      return { ok: false as const, error: "Esta tienda no tiene Gerente de Tienda." };
    // Temporal de alta entropía (~2^40) pero tecleable: "Ampm-" + 10 hex.
    const temp = "Ampm-" + crypto.randomBytes(5).toString("hex");
    const emails: string[] = [];
    for (const uid of gtIds) {
      const { data: upd, error } = await supabaseAdmin.auth.admin.updateUserById(uid, { password: temp });
      if (error) return { ok: false as const, error: error.message };
      if (upd?.user?.email) emails.push(upd.user.email);
    }
    return { ok: true as const, password: temp, emails };
  });

/** List managers (with email) for a given store. */
export const listStoreManagers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ storeId: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertCanManageStore(context.userId, data.storeId);
    const { data: rows } = await supabaseAdmin
      .from("store_managers").select("id, user_id, created_at").eq("store_id", data.storeId);
    const list = rows ?? [];
    const result: Array<{ id: string; user_id: string; email: string | null; created_at: string }> = [];
    for (const r of list) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(r.user_id);
      result.push({ ...r, email: u?.user?.email ?? null });
    }
    return result;
  });

/** Invite / assign manager by email. Creates the auth user if missing. */
export const addStoreManager = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    storeId: z.string().uuid(),
    email: z.string().email(),
    password: z.string().min(8).max(72).optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertCanManageStore(context.userId, data.storeId);

    // Find existing user by email (paginate up to a reasonable size)
    let userId: string | null = null;
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const match = list?.users?.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
    if (match) userId = match.id;

    if (!userId) {
      if (!data.password) {
        return { ok: false as const, error: "El usuario no existe. Define una contraseña inicial." };
      }
      const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: true,
      });
      if (error || !created.user) return { ok: false as const, error: error?.message ?? "No se pudo crear el usuario" };
      userId = created.user.id;
    }

    const { error } = await supabaseAdmin
      .from("store_managers")
      .insert({ user_id: userId, store_id: data.storeId });
    if (error && !error.message.includes("duplicate")) {
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });

export const removeStoreManager = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    // Look up which store this assignment belongs to, then check scope
    const { data: row } = await supabaseAdmin
      .from("store_managers").select("store_id").eq("id", data.id).maybeSingle();
    if (!row) throw new Error("Asignación no encontrada");
    await assertCanManageStore(context.userId, row.store_id);
    const { error } = await supabaseAdmin.from("store_managers").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });