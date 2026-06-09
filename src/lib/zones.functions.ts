import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getUserRoles, getAccessibleStoreIds } from "./admin.functions";

async function assertAdminOrOps(userId: string) {
  const roles = await getUserRoles(userId);
  if (!roles.includes("admin") && !roles.includes("gerente_operaciones"))
    throw new Error("Acceso denegado: solo Admin/Gerente de Operaciones");
}

/** List zones visible to current user. Admin/Ops/StoreAdmin see all; Zone admin sees only assigned. */
export const listZones = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const roles = await getUserRoles(context.userId);
    const isAdmin = roles.includes("admin") || roles.includes("gerente_operaciones");
    if (isAdmin) {
      const { data, error } = await supabaseAdmin
        .from("zones").select("id, code, name, active, created_at").order("code");
      if (error) throw new Error(error.message);
      return data ?? [];
    }
    // Zone manager: only assigned zones
    const { data: assigns } = await supabaseAdmin
      .from("user_zone_assignments").select("zone_id").eq("user_id", context.userId);
    const ids = (assigns ?? []).map((r) => r.zone_id);
    if (ids.length === 0) {
      // store_admins can still need zones list to show zone column; return zones of accessible stores
      const storeIds = await getAccessibleStoreIds(context.userId);
      if (storeIds.length === 0) return [];
      const { data: stores } = await supabaseAdmin
        .from("stores").select("zone_id").in("id", storeIds);
      const zoneIds = Array.from(new Set((stores ?? []).map((s) => s.zone_id).filter(Boolean))) as string[];
      if (zoneIds.length === 0) return [];
      const { data } = await supabaseAdmin
        .from("zones").select("id, code, name, active, created_at").in("id", zoneIds).order("code");
      return data ?? [];
    }
    const { data, error } = await supabaseAdmin
      .from("zones").select("id, code, name, active, created_at").in("id", ids).order("code");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const zoneInput = z.object({
  code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
});

export const createZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => zoneInput.parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const { error } = await supabaseAdmin.from("zones").insert({
      code: data.code.toUpperCase(), name: data.name, active: data.active,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const patch: { name?: string; active?: boolean } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.active !== undefined) patch.active = data.active;
    const { error } = await supabaseAdmin.from("zones").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertAdminOrOps(context.userId);
    const { error } = await supabaseAdmin.from("zones").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });