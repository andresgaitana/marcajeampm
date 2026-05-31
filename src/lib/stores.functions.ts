import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hashPin } from "./pin.server";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Acceso denegado: se requiere rol de administrador");
}

/** List stores: admin sees all, manager sees only assigned. */
export const listStores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: adminRow } = await supabaseAdmin
      .from("user_roles").select("role").eq("user_id", context.userId).eq("role", "admin").maybeSingle();
    if (adminRow) {
      const { data, error } = await supabaseAdmin
        .from("stores")
        .select("id, code, name, address, active, created_at")
        .order("code", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    }
    const { data: assigns } = await supabaseAdmin
      .from("store_managers").select("store_id").eq("user_id", context.userId);
    const ids = (assigns ?? []).map((r) => r.store_id);
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from("stores")
      .select("id, code, name, address, active, created_at")
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
});

export const createStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => storeInput.parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("stores").insert({
      code: data.code.toUpperCase(),
      name: data.name,
      address: data.address || null,
      terminal_pin_hash: hashPin(data.terminal_pin),
      active: data.active,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(255).nullable().optional(),
    terminal_pin: z.string().trim().regex(/^\d{4,8}$/).optional(),
    active: z.boolean().optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const patch: {
      name?: string;
      address?: string | null;
      active?: boolean;
      terminal_pin_hash?: string;
    } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.address !== undefined) patch.address = data.address;
    if (data.active !== undefined) patch.active = data.active;
    if (data.terminal_pin !== undefined) patch.terminal_pin_hash = hashPin(data.terminal_pin);
    const { error } = await supabaseAdmin.from("stores").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("stores").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** List managers (with email) for a given store. */
export const listStoreManagers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ storeId: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
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
    await assertAdmin(context.userId);

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
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("store_managers").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });