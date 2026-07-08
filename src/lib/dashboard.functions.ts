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
  area?: string | null;
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

/**
 * Área operativa de un marcaje: la que quedó REGISTRADA en el marcaje (polivalente
 * que escogió área al entrar, o cobertura) tiene prioridad; si no hay, se deriva del
 * rol (cajero → Productos, agente_mbk → MBK). Devuelve null si no aplica a dotación.
 */
function effectiveArea(recArea: string | null | undefined, role: string | undefined): "productos" | "mbk" | null {
  if (recArea === "productos" || recArea === "mbk") return recArea;
  if (role === "cajero") return "productos";
  if (role === "agente_mbk") return "mbk";
  return null;
}

// ── Clasificación del HORARIO (quién marcó) por categoría de personal ──
type SchedCat = "PROD" | "MBK" | "GT" | "LIMP" | "SEG" | "TERC";
/** Categoría del horario según el rol (y el área marcada, para polivalentes/cobertura).
 * gerente_zona y otros roles no-tienda quedan fuera del roster (null). */
function scheduleArea(role: string, recArea: string | null | undefined): SchedCat | null {
  if (role === "cajero" || role === "agente_mbk") return effectiveArea(recArea, role) === "mbk" ? "MBK" : "PROD";
  if (role === "gerente") return "GT";
  if (role === "personal_limpieza") return "LIMP";
  if (role === "seguridad_interna" || role === "seguridad") return "SEG";
  if (role === "seguridad_tercerizada") return "TERC";
  return null;
}
/** Turno AM/PM por hora local NI de ENTRADA. MBK corta a las 13:00; el resto a las 17:00. */
function scheduleShift(cat: SchedCat, hour: number): "AM" | "PM" {
  return cat === "MBK" ? (hour >= 5 && hour < 13 ? "AM" : "PM") : (hour >= 5 && hour < 17 ? "AM" : "PM");
}
/** Filas del horario general (excluye Tercerizada, que va en su propio documento). */
const SCHED_ROW_DEFS = [
  { key: "PROD_AM", cat: "PROD" as SchedCat, shift: "AM" as const, label: "Productos AM · 6:00-18:00" },
  { key: "PROD_PM", cat: "PROD" as SchedCat, shift: "PM" as const, label: "Productos PM · 18:00-6:00" },
  { key: "MBK_AM", cat: "MBK" as SchedCat, shift: "AM" as const, label: "MBK AM · 6:00-14:00" },
  { key: "MBK_PM", cat: "MBK" as SchedCat, shift: "PM" as const, label: "MBK PM · 14:00-22:00" },
  { key: "GT_AM", cat: "GT" as SchedCat, shift: "AM" as const, label: "Gerente de Tienda AM" },
  { key: "GT_PM", cat: "GT" as SchedCat, shift: "PM" as const, label: "Gerente de Tienda PM" },
  { key: "LIMP_AM", cat: "LIMP" as SchedCat, shift: "AM" as const, label: "Limpieza AM" },
  { key: "LIMP_PM", cat: "LIMP" as SchedCat, shift: "PM" as const, label: "Limpieza PM" },
  { key: "SEG_AM", cat: "SEG" as SchedCat, shift: "AM" as const, label: "Seguridad interna AM" },
  { key: "SEG_PM", cat: "SEG" as SchedCat, shift: "PM" as const, label: "Seguridad interna PM" },
] as const;

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
    // "Hoy" en hora de Nicaragua (UTC-6), no la del servidor.
    const nowNI = new Date(Date.now() - NI_OFFSET_MS);
    const todayStr = nowNI.toISOString().slice(0, 10);
    const startOfTodayMs = new Date(todayStr + "T00:00:00Z").getTime() + NI_OFFSET_MS;
    // Se traen al menos 7 días para poder calcular la dotación semanal.
    const lookbackDays = Math.max(data.days, 7);
    const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

    let q = supabaseAdmin
      .from("attendance_records")
      .select("id, type, created_at, employee_id, store_id, area")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(8000);
    if (effective !== "all") q = q.in("store_id", effective);
    const { data: rows } = await q;
    const records = (rows ?? []) as Rec[];

    // Stores in scope
    let storesQ = supabaseAdmin.from("stores").select("id, code, name, active, zone_id");
    if (effective !== "all") storesQ = storesQ.in("id", effective);
    const { data: storesData } = await storesQ;
    const stores = storesData ?? [];

    // Today metrics
    const todayRecs = records.filter((r) => new Date(r.created_at).getTime() >= startOfTodayMs);
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
      const d = new Date(Date.now() - NI_OFFSET_MS);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const startMs = d.getTime() + NI_OFFSET_MS;
      const nextMs = startMs + 24 * 3600 * 1000;
      const dayRecs = records.filter((r) => {
        const t = new Date(r.created_at).getTime();
        return t >= startMs && t < nextMs;
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

    // ---- DOTACIÓN por ÁREA (Productos + MBK) y CORTE, como en la pestaña Dotación ----
    // Objetivo: saber si la tienda está lista para operar el turno ACTUAL. Se separa
    // Productos (cajero) y MBK (agente_mbk), cada uno con su corte y plan.
    const roleById = new Map(employees.map((e) => [e.id as string, e.role as string]));
    const { data: stf } = await supabaseAdmin.from("store_staffing").select("store_id, prod_agents, mbk_agents");
    const staffMap = new Map((stf ?? []).map((x) => [x.store_id as string, x]));
    const planFor = (sid: string, dow: number) => {
      const st = staffMap.get(sid);
      return dotacionPlan(st?.prod_agents ?? 0, st?.mbk_agents ?? 0, dow);
    };
    const weekDayInfo: Array<{ date: string; dow: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - NI_OFFSET_MS);
      d.setUTCDate(d.getUTCDate() - i);
      weekDayInfo.push({ date: d.toISOString().slice(0, 10), dow: d.getUTCDay() });
    }
    const weekDaySet = new Set(weekDayInfo.map((w) => w.date));
    const dowToday = new Date(todayStr + "T00:00:00Z").getUTCDay();
    const hourNow = nowNI.getUTCHours();
    // Corte actual por área (mismas bandas que la pestaña Dotación: Prod AM 5-17, MBK AM 5-13).
    const prodCorte: "AM" | "PM" = hourNow >= 5 && hourNow < 17 ? "AM" : "PM";
    const mbkCorte: "AM" | "PM" = hourNow >= 5 && hourNow < 13 ? "AM" : "PM";

    type Buck = { pAm: Set<string>; pPm: Set<string>; mAm: Set<string>; mPm: Set<string> };
    const newBuck = (): Buck => ({ pAm: new Set(), pPm: new Set(), mAm: new Set(), mPm: new Set() });
    const todayBuck = new Map<string, Buck>();
    for (const r of todayRecs) {
      if (r.type !== "entrada") continue;
      const area = effectiveArea(r.area, roleById.get(r.employee_id));
      if (!area) continue;
      const hour = managuaParts(r.created_at).hour;
      if (!todayBuck.has(r.store_id)) todayBuck.set(r.store_id, newBuck());
      const b = todayBuck.get(r.store_id)!;
      if (area === "productos") (hour >= 5 && hour < 17 ? b.pAm : b.pPm).add(r.employee_id);
      else (hour >= 5 && hour < 13 ? b.mAm : b.mPm).add(r.employee_id);
    }
    // Semana: distintos por tienda/área/día (para sumar la cobertura de los 7 días).
    const weekProd = new Map<string, Map<string, Set<string>>>();
    const weekMbk = new Map<string, Map<string, Set<string>>>();
    for (const r of records) {
      if (r.type !== "entrada") continue;
      const area = effectiveArea(r.area, roleById.get(r.employee_id));
      if (!area) continue;
      const ds = managuaParts(r.created_at).date;
      if (!weekDaySet.has(ds)) continue;
      const target = area === "productos" ? weekProd : weekMbk;
      if (!target.has(r.store_id)) target.set(r.store_id, new Map());
      const dm = target.get(r.store_id)!;
      if (!dm.has(ds)) dm.set(ds, new Set());
      dm.get(ds)!.add(r.employee_id);
    }
    const sumDistinct = (m: Map<string, Set<string>> | undefined) => {
      let n = 0; if (m) for (const s of m.values()) n += s.size; return n;
    };

    const dotByStore = new Map<string, {
      prodReal: number; prodPlan: number; mbkReal: number; mbkPlan: number;
      wProdReal: number; wProdPlan: number; wMbkReal: number; wMbkPlan: number;
    }>();
    for (const s of stores) {
      const b = todayBuck.get(s.id) ?? newBuck();
      const pl = planFor(s.id, dowToday);
      dotByStore.set(s.id, {
        prodReal: prodCorte === "AM" ? b.pAm.size : b.pPm.size,
        prodPlan: prodCorte === "AM" ? pl.prodAm : pl.prodPm,
        mbkReal: mbkCorte === "AM" ? b.mAm.size : b.mPm.size,
        mbkPlan: mbkCorte === "AM" ? pl.mbkAm : pl.mbkPm,
        wProdReal: sumDistinct(weekProd.get(s.id)),
        wProdPlan: weekDayInfo.reduce((a, w) => { const p = planFor(s.id, w.dow); return a + p.prodAm + p.prodPm; }, 0),
        wMbkReal: sumDistinct(weekMbk.get(s.id)),
        wMbkPlan: weekDayInfo.reduce((a, w) => { const p = planFor(s.id, w.dow); return a + p.mbkAm + p.mbkPm; }, 0),
      });
    }
    const dotacionToday = { real: 0, plan: 0, pct: 0 };
    const dotacionWeek = { real: 0, plan: 0, pct: 0 };
    for (const v of dotByStore.values()) {
      dotacionToday.real += v.prodReal + v.mbkReal; dotacionToday.plan += v.prodPlan + v.mbkPlan;
      dotacionWeek.real += v.wProdReal + v.wMbkReal; dotacionWeek.plan += v.wProdPlan + v.wMbkPlan;
    }
    dotacionToday.pct = dotacionToday.plan > 0 ? Math.round((dotacionToday.real / dotacionToday.plan) * 100) : 0;
    dotacionWeek.pct = dotacionWeek.plan > 0 ? Math.round((dotacionWeek.real / dotacionWeek.plan) * 100) : 0;

    const byStoreExec = byStore.map((s) => {
      const d = dotByStore.get(s.id);
      return {
        ...s,
        employees: empStoreMap.get(s.id)?.total ?? 0,
        present_today: empStoreMap.get(s.id)?.present ?? 0,
        dot_prod_real: d?.prodReal ?? 0, dot_prod_plan: d?.prodPlan ?? 0,
        dot_mbk_real: d?.mbkReal ?? 0, dot_mbk_plan: d?.mbkPlan ?? 0,
        dot_wprod_real: d?.wProdReal ?? 0, dot_wprod_plan: d?.wProdPlan ?? 0,
        dot_wmbk_real: d?.wMbkReal ?? 0, dot_wmbk_plan: d?.wMbkPlan ?? 0,
      };
    });

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
      dotacion_today: dotacionToday,
      dotacion_week: dotacionWeek,
      prod_corte: prodCorte,
      mbk_corte: mbkCorte,
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
      // Rango explícito (fechas locales NI, yyyy-mm-dd). Si vienen ambos, tienen
      // prioridad sobre `days`. El rango es inclusivo en ambos extremos.
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
    // Ventana: con from/to (fechas locales NI) se usa [from 00:00, to+1 00:00);
    // si no, la ventana de los últimos `days` días hasta ahora.
    let fromISO: string;
    let toISO: string | null = null;
    if (data.from && data.to) {
      const a = data.from <= data.to ? data.from : data.to;
      const b = data.from <= data.to ? data.to : data.from;
      fromISO = new Date(new Date(a + "T00:00:00Z").getTime() + NI_OFFSET_MS).toISOString();
      toISO = new Date(new Date(b + "T00:00:00Z").getTime() + NI_OFFSET_MS + 24 * 3600 * 1000).toISOString();
    } else {
      const since = new Date();
      since.setDate(since.getDate() - data.days);
      fromISO = since.toISOString();
    }
    let q = supabaseAdmin
      .from("attendance_records")
      .select("created_at, type, location_valid, employee:employees!employee_id(full_name, employee_code, cedula, role), store:stores(code, name)")
      .gte("created_at", fromISO)
      .order("created_at", { ascending: false })
      .limit(20000);
    if (toISO) q = q.lt("created_at", toISO);
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
        cedula: e?.cedula ?? "",
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
      .select("created_at, notes, area, employee:employees!employee_id(id, full_name, role)")
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

    // Pantalla: filas generales (Productos, MBK, GT, Limpieza, Seguridad) + Tercerizada.
    const rowDefs = [
      ...SCHED_ROW_DEFS,
      { key: "TERC_AM", cat: "TERC" as SchedCat, shift: "AM" as const, label: "Seguridad Tercerizada AM" },
      { key: "TERC_PM", cat: "TERC" as SchedCat, shift: "PM" as const, label: "Seguridad Tercerizada PM" },
    ];
    // Dedup por colaborador (id), no por nombre, para no colapsar homónimos.
    const buckets: Record<string, Array<Map<string, string>>> = {};
    for (const r of rowDefs) buckets[r.key] = days.map(() => new Map<string, string>());

    for (const rec of rows ?? []) {
      const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
      if (!emp) continue;
      const { date, hour } = managuaParts(rec.created_at as string);
      const di = dayIndex.get(date);
      if (di === undefined) continue;
      const cat = scheduleArea(emp.role as string, rec.area as string | null);
      if (!cat) continue; // gerente_zona u otros: fuera del roster
      const shift = scheduleShift(cat, hour);
      const key = `${cat}_${shift}`;
      // Para Seguridad Tercerizada (usuario compartido) agrupamos por NOMBRE del
      // guarda capturado en el marcaje, no por el usuario; así se ven los distintos.
      let identity = emp.id as string;
      let display = (emp.full_name as string) ?? "—";
      if (cat === "TERC") {
        const gn = guardNameFromNotes(rec.notes as string | null);
        if (gn) { identity = `g:${gn.toLowerCase()}`; display = gn; }
      }
      buckets[key][di].set(identity, display);
    }

    const gridRows = rowDefs.map((r) => ({
      key: r.key,
      area: r.cat,
      shift: r.shift,
      label: r.label,
      cells: buckets[r.key].map((m, i) => ({
        date: days[i].date,
        people: [...m.entries()].map(([id, name]) => ({ id, name })),
      })),
    }));

    return { weekStart: days[0].date, weekEnd: days[6].date, days, rows: gridRows };
  });

/**
 * Horario para IMPRIMIR/descargar: una o varias semanas de UNA tienda. Devuelve, por
 * semana, (a) las filas generales del roster (Productos, MBK, GT, Limpieza, Seguridad
 * interna) con quién marcó ENTRADA por día/turno, y (b) el detalle de la Seguridad
 * Tercerizada (entrada/salida y horas por guarda) para verificar cumplimiento/asistencia.
 */
export const getSchedulePrint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      weeks: z.number().int().min(1).max(8).default(1),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    if (scope.storeIds !== "all" && !scope.storeIds.includes(data.storeId))
      throw new Error("Sin acceso a esta tienda");

    const { data: store } = await supabaseAdmin
      .from("stores").select("code, name").eq("id", data.storeId).maybeSingle();

    // Lunes 00:00 NI de la semana inicial (misma lógica que getWeeklySchedule).
    let mondayLocal: Date;
    if (data.weekStart) {
      mondayLocal = new Date(data.weekStart + "T00:00:00Z");
      const dow = (mondayLocal.getUTCDay() + 6) % 7;
      if (dow !== 0) mondayLocal.setUTCDate(mondayLocal.getUTCDate() - dow);
    } else {
      const nowLocal = new Date(Date.now() - NI_OFFSET_MS);
      const dow = (nowLocal.getUTCDay() + 6) % 7;
      mondayLocal = new Date(nowLocal);
      mondayLocal.setUTCHours(0, 0, 0, 0);
      mondayLocal.setUTCDate(mondayLocal.getUTCDate() - dow);
    }
    const totalDays = data.weeks * 7;
    const SHIFT_MAX = 14 * 3600 * 1000;
    const fromUTC = new Date(mondayLocal.getTime() + NI_OFFSET_MS);
    const toUTC = new Date(fromUTC.getTime() + totalDays * 24 * 3600 * 1000);
    // Buffer de ±14h para capturar turnos nocturnos que cruzan los bordes del rango
    // (p.ej. entra domingo 18:00 y sale lunes 06:00): se parean y luego se filtran por
    // el día de ENTRADA, así solo cuentan los que arrancan dentro del rango impreso.
    const fromBufUTC = new Date(fromUTC.getTime() - SHIFT_MAX);
    const toBufUTC = new Date(toUTC.getTime() + SHIFT_MAX);

    // Entradas Y salidas (la salida se usa para las horas de los tercerizados).
    const { data: rows } = await supabaseAdmin
      .from("attendance_records")
      .select("created_at, type, notes, area, employee:employees!employee_id(id, full_name, role)")
      .eq("store_id", data.storeId)
      .gte("created_at", fromBufUTC.toISOString())
      .lt("created_at", toBufUTC.toISOString())
      .order("created_at", { ascending: true })
      .limit(20000);

    const allDays = Array.from({ length: totalDays }, (_, i) => {
      const d = new Date(mondayLocal.getTime() + i * 24 * 3600 * 1000);
      return { date: d.toISOString().slice(0, 10), label: DOW_ES[d.getUTCDay()], dayNum: `${d.getUTCDate()}/${d.getUTCMonth() + 1}` };
    });
    const dateToGi = new Map(allDays.map((d, i) => [d.date, i] as const));

    // Generales: weekGeneral[w][`${rowKey}|${dayInWeek}`] = Map<id, nombre>
    const weekGeneral = Array.from({ length: data.weeks }, () => {
      const b: Record<string, Map<string, string>> = {};
      for (const rd of SCHED_ROW_DEFS) for (let di = 0; di < 7; di++) b[`${rd.key}|${di}`] = new Map();
      return b;
    });
    // Tercerizados: TODOS los eventos (entrada/salida) del rango con buffer en una sola
    // lista; se parean globalmente por guarda para no partir turnos que cruzan semanas.
    type TercEv = { type: "entrada" | "salida"; ms: number; name: string };
    const tercEvents: TercEv[] = [];

    for (const rec of rows ?? []) {
      const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
      if (!emp) continue;
      const cat = scheduleArea(emp.role as string, rec.area as string | null);
      if (!cat) continue;
      if (cat === "TERC") {
        // Nombre del guarda desde las notas (cuenta compartida). Si no hay nombre, cae
        // al usuario compartido; el marcaje exige el nombre, así que es poco común.
        const gn = guardNameFromNotes(rec.notes as string | null) ?? (emp.full_name as string) ?? "Guarda";
        tercEvents.push({ type: rec.type as "entrada" | "salida", ms: new Date(rec.created_at as string).getTime(), name: gn });
        continue;
      }
      // Generales: solo ENTRADA y solo dentro del rango impreso (el buffer no cuenta).
      if (rec.type !== "entrada") continue;
      const { date, hour } = managuaParts(rec.created_at as string);
      const gi = dateToGi.get(date);
      if (gi === undefined) continue;
      const shift = scheduleShift(cat, hour);
      weekGeneral[Math.floor(gi / 7)][`${cat}_${shift}|${gi % 7}`]?.set(emp.id as string, (emp.full_name as string) ?? "—");
    }

    // Pareo GLOBAL de tercerizados por guarda (cruza medianoche y semanas). Cada turno
    // se ancla al día de su ENTRADA; solo se conservan los anclados dentro del rango.
    type TercShift = { name: string; entrada: string | null; salida: string | null; horas: number | null };
    const shiftsByDate = new Map<string, TercShift[]>();
    const byGuard = new Map<string, TercEv[]>();
    for (const ev of tercEvents) {
      if (!byGuard.has(ev.name)) byGuard.set(ev.name, []);
      byGuard.get(ev.name)!.push(ev);
    }
    const keepShift = (s: TercShift) => {
      const anchor = s.entrada ?? s.salida!;
      const dstr = managuaParts(anchor).date;
      if (!dateToGi.has(dstr)) return; // arrancó fuera del rango impreso → no cuenta
      if (!shiftsByDate.has(dstr)) shiftsByDate.set(dstr, []);
      shiftsByDate.get(dstr)!.push(s);
    };
    for (const [name, list] of byGuard) {
      list.sort((a, b) => a.ms - b.ms);
      let open: TercEv | null = null;
      for (const ev of list) {
        if (ev.type === "entrada") {
          if (open) keepShift({ name, entrada: new Date(open.ms).toISOString(), salida: null, horas: null });
          open = ev;
        } else if (open && ev.ms - open.ms <= SHIFT_MAX) {
          keepShift({ name, entrada: new Date(open.ms).toISOString(), salida: new Date(ev.ms).toISOString(), horas: Math.round(((ev.ms - open.ms) / 3600000) * 10) / 10 });
          open = null;
        } else {
          keepShift({ name, entrada: null, salida: new Date(ev.ms).toISOString(), horas: null });
        }
      }
      if (open) keepShift({ name, entrada: new Date(open.ms).toISOString(), salida: null, horas: null });
    }

    const out = Array.from({ length: data.weeks }, (_, w) => {
      const wdays = allDays.slice(w * 7, w * 7 + 7);
      const genRows = SCHED_ROW_DEFS.map((rd) => ({
        key: rd.key,
        label: rd.label,
        cells: wdays.map((d, di) => ({
          date: d.date,
          people: [...(weekGeneral[w][`${rd.key}|${di}`] ?? new Map()).entries()].map(([id, name]) => ({ id, name })),
        })),
      }));
      const terc = wdays.map((d) => ({
        date: d.date,
        label: d.label,
        dayNum: d.dayNum,
        shifts: (shiftsByDate.get(d.date) ?? []).slice().sort((a, b) => (a.entrada ?? a.salida ?? "").localeCompare(b.entrada ?? b.salida ?? "")),
      }));
      return { weekStart: wdays[0].date, weekEnd: wdays[6].date, days: wdays, rows: genRows, terc };
    });

    return {
      store: { code: store?.code ?? "", name: store?.name ?? "" },
      weekStart: allDays[0].date,
      weekEnd: allDays[totalDays - 1].date,
      weeks: out,
    };
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
        .select("created_at, store_id, area, employee:employees!employee_id(id, full_name, role)")
        .eq("type", "entrada")
        .gte("created_at", fromISO).lt("created_at", toISO)
        .in("store_id", storeIds).limit(20000);
      for (const rec of recs ?? []) {
        const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
        if (!emp) continue;
        // Área operativa: la registrada (polivalente/cobertura) o, si no, la del rol.
        const area = effectiveArea(rec.area as string | null, emp.role as string);
        if (!area) continue;
        const { hour } = managuaParts(rec.created_at as string);
        const sid = rec.store_id as string;
        if (!byStore.has(sid)) byStore.set(sid, { prodAm: new Map(), prodPm: new Map(), mbkAm: new Map(), mbkPm: new Map() });
        const b = byStore.get(sid)!;
        // Mismas bandas que el Horario (tolerancia de llegada temprana):
        // Productos AM 5:00-17:00; MBK AM 5:00-13:00 (la tarde entra ~13:30 → PM).
        if (area === "productos") (hour >= 5 && hour < 17 ? b.prodAm : b.prodPm).set(emp.id as string, emp.full_name as string);
        else (hour >= 5 && hour < 13 ? b.mbkAm : b.mbkPm).set(emp.id as string, emp.full_name as string);
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

/**
 * Reporte de Coberturas / Apoyos: marcajes hechos en modo cobertura (un colaborador
 * que marcó en una tienda que NO es la suya). Empareja entrada→salida para dar las
 * horas de cada turno de apoyo, con la tienda que PRESTÓ y la que RECIBIÓ. Sirve para
 * que planilla reconozca las horas y la tienda de origen reporte el préstamo.
 * Alcance: incluye el turno si la tienda receptora O la de origen están en el alcance.
 */
export const getCoverageReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      days: z.number().int().min(1).max(90).default(14),
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
    const effSet = effective === "all" ? null : new Set(effective);

    const since = new Date(Date.now() - data.days * 24 * 3600 * 1000);
    const { data: recs } = await supabaseAdmin
      .from("attendance_records")
      .select("id, type, created_at, store_id, area, employee:employees!employee_id(id, full_name, employee_code, role, store_id)")
      .eq("cobertura", true)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .limit(20000);

    const { data: storesData } = await supabaseAdmin.from("stores").select("id, code, name");
    const storeMap = new Map((storesData ?? []).map((s) => [s.id as string, { code: s.code as string, name: s.name as string }]));

    // Agrupar por (colaborador + tienda donde cubre) y emparejar entrada→salida.
    type Ev = { type: "entrada" | "salida"; ms: number; area: string | null };
    const groups = new Map<string, {
      empId: string; name: string; code: string; role: string; homeStoreId: string; coverStoreId: string; evs: Ev[];
    }>();
    for (const rec of recs ?? []) {
      const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
      if (!emp) continue;
      const coverId = rec.store_id as string;
      const homeId = emp.store_id as string;
      // Incluir si la tienda que RECIBIÓ o la que PRESTÓ están en el alcance.
      if (effSet && !effSet.has(coverId) && !effSet.has(homeId)) continue;
      const key = `${emp.id}|${coverId}`;
      if (!groups.has(key)) groups.set(key, {
        empId: emp.id as string, name: emp.full_name as string, code: emp.employee_code as string,
        role: emp.role as string, homeStoreId: homeId, coverStoreId: coverId, evs: [],
      });
      groups.get(key)!.evs.push({
        type: rec.type as "entrada" | "salida",
        ms: new Date(rec.created_at as string).getTime(),
        area: (rec.area as string | null) ?? null,
      });
    }

    const SHIFT_MAX = 14 * 3600 * 1000;
    const shifts: Array<{
      empId: string; name: string; code: string; role: string;
      homeStore: string; homeStoreName: string; coverStore: string; coverStoreName: string;
      date: string; entrada: string; salida: string | null; hours: number | null; area: string | null; enCurso: boolean;
    }> = [];
    for (const g of groups.values()) {
      g.evs.sort((a, b) => a.ms - b.ms);
      const home = storeMap.get(g.homeStoreId);
      const cover = storeMap.get(g.coverStoreId);
      const pushShift = (entrada: Ev, salida: Ev | null) => {
        const local = new Date(entrada.ms - NI_OFFSET_MS);
        const areaLabel = entrada.area === "mbk" ? "MBK" : entrada.area === "productos" ? "Productos" : null;
        shifts.push({
          empId: g.empId, name: g.name, code: g.code,
          role: g.role === "agente_mbk" ? "MBK" : "Productos",
          homeStore: home?.code ?? "—", homeStoreName: home?.name ?? "",
          coverStore: cover?.code ?? "—", coverStoreName: cover?.name ?? "",
          date: local.toISOString().slice(0, 10),
          entrada: new Date(entrada.ms).toISOString(),
          salida: salida ? new Date(salida.ms).toISOString() : null,
          hours: salida ? Math.round(((salida.ms - entrada.ms) / 3600000) * 10) / 10 : null,
          area: areaLabel,
          enCurso: !salida,
        });
      };
      let open: Ev | null = null;
      for (const ev of g.evs) {
        if (ev.type === "entrada") {
          if (open) pushShift(open, null); // entrada previa sin salida
          open = ev;
        } else if (open && ev.ms - open.ms <= SHIFT_MAX) {
          pushShift(open, ev);
          open = null;
        }
        // salida huérfana (sin entrada) se ignora
      }
      if (open) pushShift(open, null);
    }
    shifts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.coverStore.localeCompare(b.coverStore)));

    const totalHours = shifts.reduce((s, x) => s + (x.hours ?? 0), 0);
    return {
      days: data.days,
      shifts,
      total_shifts: shifts.length,
      total_hours: Math.round(totalHours * 10) / 10,
    };
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

// ───────────────────────── KPI de Asistencia y Puntualidad ─────────────────────────
// Extrae 2 KPIs por colaborador (caja/MBK) para alimentar la evaluación semanal:
//  - Puntualidad en turnos  (incidencias de llegada tarde, tolerancia ±5 min)
//  - Marcaje correcto de entrada/salida (olvidos + ajustes manuales)
// Horarios esperados (entrada): Productos AM 6:00 / PM 18:00; MBK AM 6:00 / PM 14:00.

const LATE_TOLERANCE_MIN = 5;
const SHIFT_MAX_MS = 14 * 3600 * 1000;

/** Inicio esperado (min desde medianoche) y turno, según rol y hora de entrada. */
function expectedStart(role: string, mins: number): { start: number; turno: "AM" | "PM" } {
  if (role === "agente_mbk") {
    // MBK: AM 6:00 (entradas 4:00–11:00) / PM 14:00 (resto)
    return mins >= 240 && mins < 660 ? { start: 360, turno: "AM" } : { start: 840, turno: "PM" };
  }
  // Productos (cajero): AM 6:00 (entradas 4:00–16:00) / PM 18:00 (resto)
  return mins >= 240 && mins < 960 ? { start: 360, turno: "AM" } : { start: 1080, turno: "PM" };
}

/** # incidencias de puntualidad → nota 1-5 (rúbrica de evaluación). */
function scorePuntualidad(incidencias: number): number {
  if (incidencias <= 0) return 5;
  if (incidencias === 1) return 4;
  if (incidencias === 2) return 3;
  if (incidencias === 3) return 2;
  return 1;
}
/** Olvidos de marcaje + ajustes manuales → nota 1-5. */
function scoreMarcaje(olvidos: number, ajustes: number): number {
  if (olvidos >= 4) return 1;
  let s = olvidos === 0 ? 5 : olvidos === 1 ? 4 : olvidos === 2 ? 3 : 2;
  if (ajustes > 0) s = Math.min(s, 2); // requiere ajustes manuales / manipulación
  return s;
}

export const getAttendanceKpis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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

    // Semana de evaluación SÁBADO→VIERNES. Corte el sábado de madrugada (04:00 NI), en
    // el hueco entre que cierra el último PM (~6:00) y abre el AM, para que ningún turno
    // nocturno (Productos PM 18:00→6:00) quede partido entre dos semanas.
    const CUT_HOUR = 4;
    const ref = data.weekStart ? new Date(data.weekStart + "T00:00:00Z") : new Date(Date.now() - NI_OFFSET_MS);
    // Retroceder al sábado que inicia la semana (Sáb=6 → (dow+1)%7 días atrás).
    // Sin weekStart: además -7 días para evaluar la semana YA CERRADA (default del sábado).
    const back = (ref.getUTCDay() + 1) % 7 + (data.weekStart ? 0 : 7);
    ref.setUTCDate(ref.getUTCDate() - back);
    const weekStart = ref.toISOString().slice(0, 10); // sábado (yyyy-mm-dd)
    // Sábado 04:00 NI en ms UTC = medianoche UTC de esa fecha + offset NI + 4h.
    const weekStartMs = new Date(weekStart + "T00:00:00Z").getTime() + NI_OFFSET_MS + CUT_HOUR * 3600 * 1000;
    const weekEndMs = weekStartMs + 7 * 24 * 3600 * 1000;
    // Pre-buffer 12h: capturar la entrada del PM del viernes ANTERIOR que cierra este
    // sábado (para no contar su salida como huérfana). Post-buffer 6h: capturar la salida
    // del PM de este viernes que cierra el próximo sábado.
    const fromISO = new Date(weekStartMs - 12 * 3600 * 1000).toISOString();
    const toISO = new Date(weekEndMs + 6 * 3600 * 1000).toISOString();

    let sq = supabaseAdmin.from("stores").select("id, code").eq("active", true).order("code");
    if (effective !== "all") sq = sq.in("id", effective);
    const { data: storesData } = await sq;
    const stores = storesData ?? [];
    const storeIds = stores.map((s) => s.id as string);
    const storeCode = new Map(stores.map((s) => [s.id as string, s.code as string]));
    if (!storeIds.length) return { weekStart, rows: [] };

    const { data: recs } = await supabaseAdmin
      .from("attendance_records")
      .select("type, created_at, store_id, face_override_by, employee:employees!employee_id(id, full_name, role)")
      .gte("created_at", fromISO).lt("created_at", toISO)
      .in("store_id", storeIds).limit(50000);

    type Ev = { type: "entrada" | "salida"; ms: number; date: string; mins: number; override: boolean; inWeek: boolean };
    type Emp = { id: string; name: string; role: string; storeId: string; evs: Ev[] };
    const byEmp = new Map<string, Emp>();
    for (const rec of recs ?? []) {
      const emp = Array.isArray(rec.employee) ? rec.employee[0] : rec.employee;
      if (!emp) continue;
      const role = emp.role as string;
      if (role !== "cajero" && role !== "agente_mbk") continue;
      const id = emp.id as string;
      if (!byEmp.has(id)) byEmp.set(id, { id, name: emp.full_name as string, role, storeId: rec.store_id as string, evs: [] });
      const t = new Date(rec.created_at as string).getTime();
      const local = new Date(t - NI_OFFSET_MS);
      byEmp.get(id)!.evs.push({
        type: rec.type as "entrada" | "salida",
        ms: t,
        date: local.toISOString().slice(0, 10),
        mins: local.getUTCHours() * 60 + local.getUTCMinutes(),
        override: !!rec.face_override_by,
        inWeek: t >= weekStartMs && t < weekEndMs, // los del buffer quedan fuera del conteo
      });
    }

    const DEDUP_MS = 10 * 60 * 1000; // marcajes del mismo tipo en < 10 min = doble toque
    const rows = [...byEmp.values()].map((e) => {
      e.evs.sort((a, b) => a.ms - b.ms);
      // Colapsar marcajes duplicados (mismo tipo en < 10 min): no son olvidos.
      const evs: Ev[] = [];
      for (const ev of e.evs) {
        const last = evs[evs.length - 1];
        if (last && last.type === ev.type && ev.ms - last.ms <= DEDUP_MS) continue;
        evs.push(ev);
      }

      // Puntualidad: solo entradas DENTRO de la semana; agrupar por (fecha,turno), la más temprana.
      const shiftMap = new Map<string, { date: string; turno: "AM" | "PM"; mins: number; start: number }>();
      for (const ev of evs) {
        if (ev.type !== "entrada" || !ev.inWeek) continue;
        const { start, turno } = expectedStart(e.role, ev.mins);
        const key = `${ev.date}|${turno}`;
        const cur = shiftMap.get(key);
        if (!cur || ev.mins < cur.mins) shiftMap.set(key, { date: ev.date, turno, mins: ev.mins, start });
      }
      const detalle = [...shiftMap.values()]
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.mins - b.mins))
        .map((s) => {
          const atraso = s.mins - s.start;
          return {
            date: s.date,
            turno: s.turno,
            hora: `${String(Math.floor(s.mins / 60)).padStart(2, "0")}:${String(s.mins % 60).padStart(2, "0")}`,
            atraso,
            tarde: atraso > LATE_TOLERANCE_MIN,
          };
        });
      const incidencias = detalle.filter((d) => d.tarde).length;

      // Marcaje correcto: emparejar entrada→salida cruzando la medianoche (la salida del
      // PM puede caer en el buffer del sábado). Se cuenta solo el turno cuya ENTRADA está
      // dentro de la semana; la salida se sigue aunque caiga fuera.
      let olvidos = 0;
      let completos = 0;
      let open: Ev | null = null;
      for (const ev of evs) {
        if (ev.type === "entrada") {
          if (open && open.inWeek) olvidos++; // entrada de la semana que nunca se cerró
          open = ev;
        } else {
          if (open && ev.ms - open.ms <= SHIFT_MAX_MS) {
            if (open.inWeek) completos++;
            open = null;
          } else {
            if (ev.inWeek) olvidos++; // salida sin entrada
            if (open && open.inWeek) olvidos++; // entrada previa huérfana (gap > 14h)
            open = null;
          }
        }
      }
      // Última entrada abierta: solo es "olvido" si el turno ya debió cerrar (>14h sin
      // salida). Si entró hace poco (turno EN CURSO a media semana), aún no es olvido.
      if (open && open.inWeek && Date.now() - open.ms > SHIFT_MAX_MS) olvidos++;
      const ajustes = evs.filter((v) => v.inWeek && v.override).length;

      return {
        employeeId: e.id,
        name: e.name,
        role: e.role === "agente_mbk" ? "MBK" : "Productos",
        store: storeCode.get(e.storeId) ?? "",
        turnos: detalle.length,
        finalizados: completos,
        incidencias,
        scorePuntualidad: scorePuntualidad(incidencias),
        olvidos,
        ajustes,
        scoreMarcaje: scoreMarcaje(olvidos, ajustes),
        detalle,
      };
    }).sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : a.name.localeCompare(b.name)));

    return { weekStart, rows };
  });