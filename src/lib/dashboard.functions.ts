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

/** Extrae el nombre del guarda desde las notas ("Guarda tercerizado: NOMBRE (EMPRESA)"). */
function guardNameFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m = notes.match(/Guarda tercerizado:\s*([^(·]+?)\s*(?:\(|·|$)/);
  return m ? m[1].trim() : null;
}

export const getDashboardMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid().optional(),
      zoneId: z.string().uuid().optional(),
      days: z.number().int().min(1).max(90).default(7),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    // Alcance efectivo: el del usuario, opcionalmente reducido por tienda o zona seleccionada.
    let effective: string[] | "all" = scope.storeIds;
    if (data.storeId) {
      effective = scope.storeIds === "all" || scope.storeIds.includes(data.storeId) ? [data.storeId] : [];
    } else if (data.zoneId) {
      const { data: zs } = await supabaseAdmin.from("stores").select("id").eq("zone_id", data.zoneId);
      let ids = (zs ?? []).map((s) => s.id as string);
      if (scope.storeIds !== "all") ids = ids.filter((id) => (scope.storeIds as string[]).includes(id));
      effective = ids;
    }
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
    if (effective !== "all") q = q.in("store_id", effective);
    const { data: rows } = await q;
    const records = (rows ?? []) as Rec[];

    // Stores in scope
    let storesQ = supabaseAdmin.from("stores").select("id, code, name, active, zone_id");
    if (effective !== "all") storesQ = storesQ.in("id", effective);
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
    if (effective !== "all") empQ = empQ.in("store_id", effective);
    const { data: empData } = await empQ;
    const employees = empData ?? [];

    const { data: zoneData } = await supabaseAdmin.from("zones").select("id, code, name");
    const zoneById = new Map((zoneData ?? []).map((z) => [z.id as string, z]));

    // Presentes hoy = colaboradores con al menos una ENTRADA hoy
    const presentIds = new Set(todayRecs.filter((r) => r.type === "entrada").map((r) => r.employee_id));

    const ROLE_ORDER = ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad", "gerente", "gerente_zona"];
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
 * Exporta los marcajes del periodo (para descargar como Excel/CSV y respaldar
 * antes de cualquier purga). Solo lee datos; no borra nada. Respeta el alcance.
 */
export const exportAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      days: z.number().int().min(1).max(366).default(30),
      storeId: z.string().uuid().optional(),
      zoneId: z.string().uuid().optional(),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    let effective: string[] | "all" = scope.storeIds;
    if (data.storeId) {
      effective = scope.storeIds === "all" || scope.storeIds.includes(data.storeId) ? [data.storeId] : [];
    } else if (data.zoneId) {
      const { data: zs } = await supabaseAdmin.from("stores").select("id").eq("zone_id", data.zoneId);
      let ids = (zs ?? []).map((s) => s.id as string);
      if (scope.storeIds !== "all") ids = ids.filter((id) => (scope.storeIds as string[]).includes(id));
      effective = ids;
    }
    const since = new Date();
    since.setDate(since.getDate() - data.days);
    let q = supabaseAdmin
      .from("attendance_records")
      .select("created_at, type, location_valid, employee:employees!employee_id(full_name, employee_code, role), store:stores(code, name)")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(20000);
    if (effective !== "all") q = q.in("store_id", effective);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => {
      const e = Array.isArray(r.employee) ? r.employee[0] : r.employee;
      const s = Array.isArray(r.store) ? r.store[0] : r.store;
      // Hora local de Nicaragua (UTC-6)
      const local = new Date(new Date(r.created_at as string).getTime() - NI_OFFSET_MS);
      return {
        fecha: local.toISOString().slice(0, 10),
        hora: local.toISOString().slice(11, 16),
        codigo: e?.employee_code ?? "",
        nombre: e?.full_name ?? "",
        rol: e?.role ?? "",
        tienda: s ? `${s.code} · ${s.name}` : "",
        tipo: r.type,
        ubicacion_valida: r.location_valid ? "Sí" : "No",
      };
    });
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
      .select("created_at, notes, employee:employees!employee_id(id, full_name, role)")
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
      { key: "INT_AM", area: "Limpieza y Seg. Interna", shift: "AM", label: "Limpieza y Seg. Interna AM · 6:00-18:00" },
      { key: "INT_PM", area: "Limpieza y Seg. Interna", shift: "PM", label: "Limpieza y Seg. Interna PM · 18:00-6:00" },
      { key: "TERC_AM", area: "Seguridad Tercerizada", shift: "AM", label: "Seguridad Tercerizada AM · 6:00-18:00" },
      { key: "TERC_PM", area: "Seguridad Tercerizada", shift: "PM", label: "Seguridad Tercerizada PM · 18:00-6:00" },
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
      const role = emp.role as string;
      const area =
        role === "agente_mbk" ? "MBK"
          : role === "personal_limpieza" || role === "seguridad_interna" ? "INT"
            : role === "seguridad_tercerizada" ? "TERC"
              : "PROD";
      const shift: "AM" | "PM" = area === "MBK"
        ? (hour >= 6 && hour < 14 ? "AM" : "PM")
        : (hour >= 6 && hour < 18 ? "AM" : "PM");
      const key = `${area}_${shift}`;
      // Para Seguridad Tercerizada (usuario compartido) agrupamos por NOMBRE del
      // guarda capturado en el marcaje, no por el usuario; así se ven los distintos.
      let identity = emp.id as string;
      let display = (emp.full_name as string) ?? "—";
      if (area === "TERC") {
        const gn = guardNameFromNotes(rec.notes as string | null);
        if (gn) { identity = `g:${gn.toLowerCase()}`; display = gn; }
      }
      buckets[key][di].set(identity, display);
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

/** Plan de dotación (agentes esperados por turno) según # de agentes y día de semana (0=Dom..6=Sáb). */
function dotacionPlan(prodCount: number, mbkCount: number, dow: number) {
  // Productos: 7+ => AM2/PM2; 6 => AM 2 (Lun/Vie/Sáb/Dom) o 1 (Mar/Mié/Jue), PM2; 5 => AM1/PM2.
  let prodAm = 0, prodPm = 0;
  if (prodCount >= 7) { prodAm = 2; prodPm = 2; }
  else if (prodCount === 6) { prodAm = [0, 1, 5, 6].includes(dow) ? 2 : 1; prodPm = 2; }
  else if (prodCount === 5) { prodAm = 1; prodPm = 2; }
  // MBK: 4+ => AM 2 (excepto Mié=1), PM2; 3 => AM1/PM2; 2 => AM1/PM1; 1 => AM1/PM0.
  let mbkAm = 0, mbkPm = 0;
  if (mbkCount >= 4) { mbkAm = dow === 3 ? 1 : 2; mbkPm = 2; }
  else if (mbkCount === 3) { mbkAm = 1; mbkPm = 2; }
  else if (mbkCount === 2) { mbkAm = 1; mbkPm = 1; }
  else if (mbkCount === 1) { mbkAm = 1; mbkPm = 0; }
  return { prodAm, prodPm, mbkAm, mbkPm };
}

/**
 * Reporte de Dotación (Real vs Plan) por tienda para una fecha (hoy por defecto,
 * hora Nicaragua). Real = cajeros (Productos) y agente_mbk (MBK) que marcaron
 * ENTRADA, por turno AM/PM. Plan = dotacionPlan(presupuesto, día). Respeta alcance.
 */
export const getStaffingReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      storeId: z.string().uuid().optional(),
      zoneId: z.string().uuid().optional(),
    }).parse(i ?? {}),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    let effective: string[] | "all" = scope.storeIds;
    if (data.storeId) {
      effective = scope.storeIds === "all" || scope.storeIds.includes(data.storeId) ? [data.storeId] : [];
    } else if (data.zoneId) {
      const { data: zs } = await supabaseAdmin.from("stores").select("id").eq("zone_id", data.zoneId);
      let ids = (zs ?? []).map((s) => s.id as string);
      if (scope.storeIds !== "all") ids = ids.filter((id) => (scope.storeIds as string[]).includes(id));
      effective = ids;
    }

    const dateStr = data.date ?? new Date(Date.now() - NI_OFFSET_MS).toISOString().slice(0, 10);
    const base = new Date(dateStr + "T00:00:00Z");
    const dow = base.getUTCDay();
    const fromMs = base.getTime() + NI_OFFSET_MS;
    const fromISO = new Date(fromMs).toISOString();
    const toISO = new Date(fromMs + 24 * 3600 * 1000).toISOString();

    let sq = supabaseAdmin.from("stores").select("id, code, name, zone_id, zones(code, name)").eq("active", true).order("code");
    if (effective !== "all") sq = sq.in("id", effective);
    const { data: storesData } = await sq;
    const stores = storesData ?? [];
    const storeIds = stores.map((s) => s.id);

    const { data: stf } = await supabaseAdmin.from("store_staffing").select("store_id, prod_agents, mbk_agents");
    const staffMap = new Map((stf ?? []).map((x) => [x.store_id as string, x]));

    type Buckets = { prodAm: Map<string, string>; prodPm: Map<string, string>; mbkAm: Map<string, string>; mbkPm: Map<string, string> };
    const byStore = new Map<string, Buckets>();
    if (storeIds.length) {
      const { data: recs } = await supabaseAdmin
        .from("attendance_records")
        .select("created_at, store_id, employee:employees!employee_id(id, full_name, role)")
        .eq("type", "entrada")
        .gte("created_at", fromISO).lt("created_at", toISO)
        .in("store_id", storeIds).limit(20000);
      for (const rec of recs ?? []) {
        const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
        if (!emp) continue;
        const role = emp.role as string;
        if (role !== "cajero" && role !== "agente_mbk") continue;
        const { hour } = managuaParts(rec.created_at as string);
        const sid = rec.store_id as string;
        if (!byStore.has(sid)) byStore.set(sid, { prodAm: new Map(), prodPm: new Map(), mbkAm: new Map(), mbkPm: new Map() });
        const b = byStore.get(sid)!;
        if (role === "cajero") (hour >= 6 && hour < 18 ? b.prodAm : b.prodPm).set(emp.id as string, emp.full_name as string);
        else (hour >= 6 && hour < 14 ? b.mbkAm : b.mbkPm).set(emp.id as string, emp.full_name as string);
      }
    }

    const rows = stores.map((s) => {
      const st = staffMap.get(s.id);
      const prodCount = st?.prod_agents ?? 0;
      const mbkCount = st?.mbk_agents ?? 0;
      const plan = dotacionPlan(prodCount, mbkCount, dow);
      const b = byStore.get(s.id) ?? { prodAm: new Map(), prodPm: new Map(), mbkAm: new Map(), mbkPm: new Map() };
      const z = Array.isArray(s.zones) ? s.zones[0] : s.zones;
      const cell = (m: Map<string, string>, planN: number) => ({ real: m.size, plan: planN, names: [...m.values()] });
      const prod = { am: cell(b.prodAm, plan.prodAm), pm: cell(b.prodPm, plan.prodPm) };
      const mbk = { am: cell(b.mbkAm, plan.mbkAm), pm: cell(b.mbkPm, plan.mbkPm) };
      const realTotal = prod.am.real + prod.pm.real + mbk.am.real + mbk.pm.real;
      const planTotal = plan.prodAm + plan.prodPm + plan.mbkAm + plan.mbkPm;
      return {
        id: s.id, code: s.code, name: s.name, zone: z?.code ?? "",
        prodAgents: prodCount, mbkAgents: mbkCount,
        prod, mbk, realTotal, planTotal,
        pct: planTotal > 0 ? Math.round((realTotal / planTotal) * 100) : 0,
      };
    });
    return { date: dateStr, dow, rows };
  });

/** Editar el presupuesto de agentes de una tienda (solo Super admin). */
export const setStoreStaffing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      prodAgents: z.number().int().min(0).max(50),
      mbkAgents: z.number().int().min(0).max(50),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (!scope.isAdmin && !scope.isOperations) throw new Error("Solo Super admin puede editar el presupuesto de dotación");
    const { error } = await supabaseAdmin.from("store_staffing").upsert(
      { store_id: data.storeId, prod_agents: data.prodAgents, mbk_agents: data.mbkAgents, updated_at: new Date().toISOString() },
      { onConflict: "store_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });