import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getScope } from "./admin.functions";

/** Returns Monday 00:00 of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

type Rec = {
  id: string;
  type: "entrada" | "salida";
  created_at: string;
  employee_id: string;
  store_id: string;
};

// Nicaragua = UTC-6 todo el año (sin horario de verano desde 2006).
const NI_OFFSET_MS = 6 * 3600 * 1000;
const DOW_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** Fecha local (yyyy-mm-dd) y hora local (0-23) de Nicaragua para un timestamp UTC. */
function managuaParts(iso: string): { date: string; hour: number } {
  const local = new Date(new Date(iso).getTime() - NI_OFFSET_MS);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

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
    let storesQ = supabaseAdmin.from("stores").select("id, code, name, active, zone_id");
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

    // ---- Vista ejecutiva por nivel ----
    // Colaboradores activos en alcance
    let empQ = supabaseAdmin
      .from("employees")
      .select("id, full_name, employee_code, role, store_id")
      .eq("active", true);
    if (scope.storeIds !== "all") empQ = empQ.in("store_id", scope.storeIds);
    const { data: empData } = await empQ;
    const employees = empData ?? [];

    const { data: zoneData } = await supabaseAdmin.from("zones").select("id, code, name");
    const zoneById = new Map((zoneData ?? []).map((z) => [z.id as string, z]));

    // Presentes hoy = colaboradores con al menos una ENTRADA hoy
    const presentIds = new Set(todayRecs.filter((r) => r.type === "entrada").map((r) => r.employee_id));

    const ROLE_ORDER = ["cajero", "agente_mbk", "gerente", "seguridad", "gerente_zona"];
    const roleMap = new Map<string, { role: string; employees: number; present: number }>();
    const empStoreMap = new Map<string, { total: number; present: number }>();
    for (const e of employees) {
      const role = e.role as string;
      if (!roleMap.has(role)) roleMap.set(role, { role, employees: 0, present: 0 });
      const rr = roleMap.get(role)!; rr.employees++; if (presentIds.has(e.id)) rr.present++;
      if (!empStoreMap.has(e.store_id)) empStoreMap.set(e.store_id, { total: 0, present: 0 });
      const sr = empStoreMap.get(e.store_id)!; sr.total++; if (presentIds.has(e.id)) sr.present++;
    }
    const byRole = [...roleMap.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

    const byStoreExec = byStore.map((s) => ({
      ...s,
      employees: empStoreMap.get(s.id)?.total ?? 0,
      present_today: empStoreMap.get(s.id)?.present ?? 0,
    }));

    // Agregado por zona (para super admin / operaciones)
    const zoneMap = new Map<string, {
      zone_id: string; code: string; name: string; stores: number; employees: number;
      present_today: number; inside_now: number; today_entries: number; period_total: number;
    }>();
    for (const s of stores) {
      const zid = (s.zone_id as string | null) ?? "none";
      const z = s.zone_id ? zoneById.get(s.zone_id as string) : null;
      if (!zoneMap.has(zid)) zoneMap.set(zid, {
        zone_id: zid, code: z?.code ?? "—", name: z?.name ?? "Sin zona",
        stores: 0, employees: 0, present_today: 0, inside_now: 0, today_entries: 0, period_total: 0,
      });
      const row = zoneMap.get(zid)!;
      const bs = byStoreExec.find((b) => b.id === s.id);
      row.stores++;
      if (bs) {
        row.employees += bs.employees; row.present_today += bs.present_today;
        row.inside_now += bs.inside_now; row.today_entries += bs.today_entries; row.period_total += bs.period_total;
      }
    }
    const byZone = [...zoneMap.values()].sort((a, b) => b.period_total - a.period_total);

    const employeesTotal = employees.length;
    const presentToday = presentIds.size;
    const attendancePct = employeesTotal > 0 ? Math.round((presentToday / employeesTotal) * 100) : 0;
    const absentToday = employees
      .filter((e) => !presentIds.has(e.id))
      .map((e) => ({ id: e.id, full_name: e.full_name, employee_code: e.employee_code, role: e.role }));

    return {
      today_entries: todayEntries,
      today_exits: todayExits,
      inside_now: inside.length,
      total_period: records.length,
      inside,
      stuck_open: stuckOpen,
      by_store: byStoreExec,
      trend,
      is_admin: scope.isAdmin || scope.isOperations,
      // Vista ejecutiva por nivel
      scope: {
        isAdmin: scope.isAdmin,
        isOperations: scope.isOperations,
        isZoneAdmin: scope.isZoneAdmin,
        isStoreAdmin: scope.isStoreAdmin,
      },
      stores_count: stores.length,
      zones_count: byZone.length,
      employees_total: employeesTotal,
      present_today: presentToday,
      attendance_pct: attendancePct,
      by_role: byRole,
      by_zone: byZone,
      absent_today: absentToday,
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

/** Weekly marks grouped by day for a single employee. */
export const getEmployeeWeeklyMarks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      employeeId: z.string().uuid(),
      range: z.enum(["current_week", "previous_week", "current_month", "payroll"]).default("current_week"),
      from: z.string().optional(), // ISO date (yyyy-mm-dd) for payroll range
      to: z.string().optional(),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const { data: emp } = await supabaseAdmin
      .from("employees").select("id, full_name, employee_code, role, store_id").eq("id", data.employeeId).maybeSingle();
    if (!emp) throw new Error("Colaborador no encontrado");
    if (scope.storeIds !== "all" && !scope.storeIds.includes(emp.store_id))
      throw new Error("Sin acceso a este colaborador");

    // Compute range
    let from: Date, to: Date;
    const now = new Date();
    if (data.range === "current_week") {
      from = startOfWeek(now);
      to = new Date(from); to.setDate(to.getDate() + 7);
    } else if (data.range === "previous_week") {
      to = startOfWeek(now);
      from = new Date(to); from.setDate(from.getDate() - 7);
    } else if (data.range === "current_month") {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else {
      if (!data.from || !data.to) throw new Error("Fechas requeridas para semana planilla");
      from = new Date(data.from + "T00:00:00");
      to = new Date(data.to + "T00:00:00");
      to.setDate(to.getDate() + 1); // include end day
    }

    const { data: recs } = await supabaseAdmin
      .from("attendance_records")
      .select("id, type, created_at, store_id, store:stores(code, name)")
      .eq("employee_id", data.employeeId)
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .order("created_at", { ascending: true });
    const records = recs ?? [];

    // Group by yyyy-mm-dd
    const byDay = new Map<string, typeof records>();
    for (const r of records) {
      const key = new Date(r.created_at).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(r);
    }

    // Build days array between from..to-1
    const days: Array<{
      date: string;
      entries: number;
      exits: number;
      first_entry: string | null;
      last_exit: string | null;
      hours: number;
      marks: Array<{ id: string; type: string; time: string; store: string | null }>;
    }> = [];
    for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const list = byDay.get(key) ?? [];
      let firstEntry: string | null = null;
      let lastExit: string | null = null;
      let totalMs = 0;
      let openEntry: Date | null = null;
      let entries = 0;
      let exits = 0;
      const marks: Array<{ id: string; type: string; time: string; store: string | null }> = [];
      for (const r of list) {
        const t = new Date(r.created_at);
        if (r.type === "entrada") {
          entries++;
          if (!firstEntry) firstEntry = r.created_at;
          openEntry = t;
        } else {
          exits++;
          lastExit = r.created_at;
          if (openEntry) {
            totalMs += t.getTime() - openEntry.getTime();
            openEntry = null;
          }
        }
        const st = Array.isArray(r.store) ? r.store[0] : r.store;
        marks.push({
          id: r.id, type: r.type, time: r.created_at,
          store: st ? `${st.code} · ${st.name}` : null,
        });
      }
      days.push({
        date: key, entries, exits, first_entry: firstEntry, last_exit: lastExit,
        hours: Math.round((totalMs / 3600000) * 10) / 10, marks,
      });
    }

    const totalHours = days.reduce((s, d) => s + d.hours, 0);
    const totalMarks = records.length;
    const daysPresent = days.filter((d) => d.marks.length > 0).length;

    return {
      employee: emp,
      from: from.toISOString(),
      to: to.toISOString(),
      days,
      total_hours: Math.round(totalHours * 10) / 10,
      total_marks: totalMarks,
      days_present: daysPresent,
    };
  });

/**
 * Horario semanal (solo lectura) de UNA tienda: muestra quién MARCÓ entrada cada
 * día, clasificado por área (MBK / Productos) y turno AM/PM según la hora local
 * de Nicaragua. Bandas:
 *   Productos: AM 6:00-18:00, PM 18:00-6:00.
 *   MBK:       AM 6:00-14:00, PM 14:00-22:00.
 * Área: rol agente_mbk → MBK; cualquier otro rol → Productos.
 */
export const getWeeklySchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // lunes (fecha local NI)
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (scope.storeIds !== "all" && !scope.storeIds.includes(data.storeId))
      throw new Error("Sin acceso a esta tienda");

    // Lunes 00:00 hora Nicaragua de la semana solicitada (o la actual).
    // Trabajamos con un Date cuyos campos UTC representan la hora local NI.
    let mondayLocal: Date;
    if (data.weekStart) {
      mondayLocal = new Date(data.weekStart + "T00:00:00Z");
      // Normalizar a lunes por si llega otra fecha (defensivo).
      const dow = (mondayLocal.getUTCDay() + 6) % 7; // 0 = lunes
      if (dow !== 0) mondayLocal.setUTCDate(mondayLocal.getUTCDate() - dow);
    } else {
      const nowLocal = new Date(Date.now() - NI_OFFSET_MS);
      const dow = (nowLocal.getUTCDay() + 6) % 7; // 0 = lunes
      mondayLocal = new Date(nowLocal);
      mondayLocal.setUTCHours(0, 0, 0, 0);
      mondayLocal.setUTCDate(mondayLocal.getUTCDate() - dow);
    }
    // Rango real en UTC para la consulta (lunes 00:00 NI = +6 h UTC).
    const fromUTC = new Date(mondayLocal.getTime() + NI_OFFSET_MS);
    const toUTC = new Date(fromUTC.getTime() + 7 * 24 * 3600 * 1000);

    const { data: rows } = await supabaseAdmin
      .from("attendance_records")
      .select("created_at, employee:employees(id, full_name, role)")
      .eq("store_id", data.storeId)
      .eq("type", "entrada")
      .gte("created_at", fromUTC.toISOString())
      .lt("created_at", toUTC.toISOString())
      .order("created_at", { ascending: true })
      .limit(5000);

    // 7 columnas: lunes..domingo (fechas locales).
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mondayLocal.getTime() + i * 24 * 3600 * 1000);
      return {
        date: d.toISOString().slice(0, 10),
        label: DOW_ES[d.getUTCDay()],
        dayNum: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`,
      };
    });
    const dayIndex = new Map(days.map((d, i) => [d.date, i] as const));

    const rowDefs = [
      { key: "PROD_AM", area: "Productos", shift: "AM", label: "Productos AM · 6:00-18:00" },
      { key: "PROD_PM", area: "Productos", shift: "PM", label: "Productos PM · 18:00-6:00" },
      { key: "MBK_AM", area: "MBK", shift: "AM", label: "MBK AM · 6:00-14:00" },
      { key: "MBK_PM", area: "MBK", shift: "PM", label: "MBK PM · 14:00-22:00" },
    ] as const;
    // Dedup por colaborador (id), no por nombre, para no colapsar homónimos.
    const buckets: Record<string, Array<Map<string, string>>> = {};
    for (const r of rowDefs) buckets[r.key] = days.map(() => new Map<string, string>());

    for (const rec of rows ?? []) {
      const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
      if (!emp) continue;
      const { date, hour } = managuaParts(rec.created_at as string);
      const di = dayIndex.get(date);
      if (di === undefined) continue;
      const isMbk = emp.role === "agente_mbk";
      const shift: "AM" | "PM" = isMbk
        ? (hour >= 6 && hour < 14 ? "AM" : "PM")
        : (hour >= 6 && hour < 18 ? "AM" : "PM");
      const key = `${isMbk ? "MBK" : "PROD"}_${shift}`;
      buckets[key][di].set(emp.id as string, (emp.full_name as string) ?? "—");
    }

    const gridRows = rowDefs.map((r) => ({
      key: r.key,
      area: r.area,
      shift: r.shift,
      label: r.label,
      cells: buckets[r.key].map((m, i) => ({
        date: days[i].date,
        people: [...m.entries()].map(([id, name]) => ({ id, name })),
      })),
    }));

    return { weekStart: days[0].date, weekEnd: days[6].date, days, rows: gridRows };
  });