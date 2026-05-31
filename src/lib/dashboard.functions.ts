import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function getScope(userId: string): Promise<{ isAdmin: boolean; storeIds: string[] | "all" }> {
  const { data: adminRow } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (adminRow) return { isAdmin: true, storeIds: "all" };
  const { data: assigns } = await supabaseAdmin
    .from("store_managers").select("store_id").eq("user_id", userId);
  const ids = (assigns ?? []).map((r) => r.store_id);
  if (ids.length === 0) throw new Error("Sin tiendas asignadas");
  return { isAdmin: false, storeIds: ids };
}

type Rec = {
  id: string;
  type: "entrada" | "salida";
  created_at: string;
  employee_id: string;
  store_id: string;
};

export const getDashboardMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid().optional(),
      days: z.number().int().min(1).max(90).default(7),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const since = new Date();
    since.setDate(since.getDate() - data.days);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    let q = supabaseAdmin
      .from("attendance_records")
      .select("id, type, created_at, employee_id, store_id")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(5000);
    if (data.storeId) q = q.eq("store_id", data.storeId);
    if (scope.storeIds !== "all") q = q.in("store_id", scope.storeIds);
    const { data: rows } = await q;
    const records = (rows ?? []) as Rec[];

    // Stores in scope
    let storesQ = supabaseAdmin.from("stores").select("id, code, name, active");
    if (scope.storeIds !== "all") storesQ = storesQ.in("id", scope.storeIds);
    const { data: storesData } = await storesQ;
    const stores = storesData ?? [];

    // Today metrics
    const todayRecs = records.filter((r) => new Date(r.created_at) >= startOfToday);
    const todayEntries = todayRecs.filter((r) => r.type === "entrada").length;
    const todayExits = todayRecs.filter((r) => r.type === "salida").length;

    // Currently inside: per employee, latest record today is "entrada"
    const latestByEmp = new Map<string, Rec>();
    for (const r of todayRecs) {
      const prev = latestByEmp.get(r.employee_id);
      if (!prev || new Date(r.created_at) > new Date(prev.created_at)) latestByEmp.set(r.employee_id, r);
    }
    const insideEmpIds = [...latestByEmp.entries()].filter(([, r]) => r.type === "entrada").map(([id]) => id);

    // Hydrate employees currently inside
    let inside: Array<{ id: string; full_name: string; employee_code: string; store_id: string; since: string }> = [];
    if (insideEmpIds.length > 0) {
      const { data: emps } = await supabaseAdmin
        .from("employees")
        .select("id, full_name, employee_code, store_id")
        .in("id", insideEmpIds);
      inside = (emps ?? []).map((e) => ({
        ...e,
        since: latestByEmp.get(e.id)!.created_at,
      }));
    }

    // Alerts: open sessions > 10h (entrada hace mucho tiempo sin salida)
    const tenHoursAgo = Date.now() - 10 * 3600 * 1000;
    const stuckOpen = inside.filter((e) => new Date(e.since).getTime() < tenHoursAgo);

    // Per-store breakdown
    const byStore = stores.map((s) => {
      const dayRecs = todayRecs.filter((r) => r.store_id === s.id);
      const periodRecs = records.filter((r) => r.store_id === s.id);
      const insideCount = inside.filter((i) => i.store_id === s.id).length;
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        active: s.active,
        today_entries: dayRecs.filter((r) => r.type === "entrada").length,
        today_exits: dayRecs.filter((r) => r.type === "salida").length,
        inside_now: insideCount,
        period_total: periodRecs.length,
      };
    }).sort((a, b) => b.period_total - a.period_total);

    // Weekly trend: day-by-day counts
    const trend: Array<{ date: string; entradas: number; salidas: number }> = [];
    for (let i = data.days - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      const dayRecs = records.filter((r) => {
        const t = new Date(r.created_at).getTime();
        return t >= d.getTime() && t < next.getTime();
      });
      trend.push({
        date: d.toISOString().slice(0, 10),
        entradas: dayRecs.filter((r) => r.type === "entrada").length,
        salidas: dayRecs.filter((r) => r.type === "salida").length,
      });
    }

    return {
      today_entries: todayEntries,
      today_exits: todayExits,
      inside_now: inside.length,
      total_period: records.length,
      inside,
      stuck_open: stuckOpen,
      by_store: byStore,
      trend,
      is_admin: scope.isAdmin,
    };
  });

/** Employee attendance summary: hours worked, days present. */
export const getEmployeeSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid().optional(),
      days: z.number().int().min(1).max(90).default(7),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const since = new Date();
    since.setDate(since.getDate() - data.days);

    let q = supabaseAdmin
      .from("attendance_records")
      .select("id, type, created_at, employee_id, store_id")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .limit(10000);
    if (data.storeId) q = q.eq("store_id", data.storeId);
    if (scope.storeIds !== "all") q = q.in("store_id", scope.storeIds);
    const { data: rows } = await q;
    const records = (rows ?? []) as Rec[];

    // group by employee
    const byEmp = new Map<string, Rec[]>();
    for (const r of records) {
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
      byEmp.get(r.employee_id)!.push(r);
    }

    const empIds = [...byEmp.keys()];
    let emps: Array<{ id: string; full_name: string; employee_code: string; role: string; store_id: string }> = [];
    if (empIds.length > 0) {
      const { data: e } = await supabaseAdmin
        .from("employees")
        .select("id, full_name, employee_code, role, store_id")
        .in("id", empIds);
      emps = e ?? [];
    }

    const result = emps.map((e) => {
      const recs = byEmp.get(e.id) ?? [];
      let totalMs = 0;
      let openEntry: Date | null = null;
      const days = new Set<string>();
      for (const r of recs) {
        const t = new Date(r.created_at);
        days.add(t.toISOString().slice(0, 10));
        if (r.type === "entrada") openEntry = t;
        else if (r.type === "salida" && openEntry) {
          totalMs += t.getTime() - openEntry.getTime();
          openEntry = null;
        }
      }
      return {
        ...e,
        days_present: days.size,
        hours: Math.round((totalMs / 3600000) * 10) / 10,
        marks: recs.length,
      };
    }).sort((a, b) => b.hours - a.hours);

    return result;
  });