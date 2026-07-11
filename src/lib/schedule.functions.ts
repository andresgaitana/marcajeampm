import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getScope } from "./admin.functions";
import type { Json } from "@/integrations/supabase/types";
import { generate, validate, suggestedCoverage, SHIFT_KEYS, type SchedPerson, type Coverage, type HistoryEntry, type ShiftKey, type Schedule, type Assignment } from "./schedule-engine";

/** Caja-capaz = agenda a caja. Los de puesto APOYO son soporte, no cuentan para la
 * cobertura (si no, se pediría cobertura que ningún cajero puede cubrir). */
const isCajaHC = (p: SchedPerson) => p.puesto !== "APOYO";

/** Verifica que el usuario tenga acceso a la tienda; devuelve prodHC/mbkHC y datos base. */
async function loadStoreCtx(userId: string, storeId: string) {
  const scope = await getScope(userId);
  if (scope.storeIds !== "all" && !scope.storeIds.includes(storeId))
    throw new Error("Sin acceso a esta tienda");
  const { data: store } = await supabaseAdmin
    .from("stores").select("id, code, name").eq("id", storeId).maybeSingle();
  if (!store) throw new Error("Tienda no encontrada");
  const { data: stf } = await supabaseAdmin
    .from("store_staffing").select("prod_agents, mbk_agents").eq("store_id", storeId).maybeSingle();
  return { store, prodBudget: stf?.prod_agents ?? null, mbkBudget: stf?.mbk_agents ?? null };
}

/** Colaboradores agendables (cajero → Productos, agente_mbk → MBK) mapeados al motor. */
async function loadTeam(storeId: string): Promise<SchedPerson[]> {
  const { data: emps } = await supabaseAdmin
    .from("employees")
    .select("id, full_name, role, puesto_horario, estudia, no_disponible, horas_meta, apoya_mbk")
    .eq("store_id", storeId).eq("active", true).in("role", ["cajero", "agente_mbk"]);
  return (emps ?? []).map((e) => ({
    id: e.id as string,
    nombre: (e.full_name as string) ?? "—",
    area: e.role === "agente_mbk" ? "MBK" : "PRODUCTOS",
    puesto: ((e.puesto_horario as string) || "AGENTE") as SchedPerson["puesto"],
    mbkQ: !!e.apoya_mbk,
    estudia: ((e.estudia as string) || "") as SchedPerson["estudia"],
    noDisponible: (e.no_disponible as string) || "",
    horasMeta: Number(e.horas_meta ?? 48),
  }));
}

/** Historial de planes aprobados (semanas previas) → nombres por turno/día, para que el
 * motor evite repetir turnos y respete el descanso domingo-noche → lunes. */
async function loadHistory(storeId: string, weekStart: string): Promise<HistoryEntry[]> {
  const { data: rows } = await supabaseAdmin
    .from("schedules")
    .select("week_start, schedule_shifts(day_index, shift_key, emp:employees!employee_id(full_name))")
    .eq("store_id", storeId).eq("status", "approved").lt("week_start", weekStart)
    .order("week_start", { ascending: false }).limit(3);
  return (rows ?? []).map((r) => {
    const flat = {} as Record<ShiftKey, string[][]>;
    SHIFT_KEYS.forEach((k) => { flat[k] = Array.from({ length: 7 }, () => [] as string[]); });
    const shifts = (r.schedule_shifts ?? []) as Array<{ day_index: number; shift_key: string; emp: { full_name?: string } | { full_name?: string }[] | null }>;
    for (const s of shifts) {
      const k = s.shift_key as ShiftKey;
      if (!flat[k] || s.day_index < 0 || s.day_index > 6) continue;
      const emp = Array.isArray(s.emp) ? s.emp[0] : s.emp;
      if (emp?.full_name) flat[k][s.day_index].push(emp.full_name);
    }
    return { weekStart: r.week_start as string, flat };
  });
}

const coverageSchema = z.object({
  PROD_AM: z.array(z.number().int().min(0).max(9)).length(7),
  PROD_PM: z.array(z.number().int().min(0).max(9)).length(7),
  MBK_AM: z.array(z.number().int().min(0).max(9)).length(7),
  MBK_PM: z.array(z.number().int().min(0).max(9)).length(7),
  mbkOff: z.number().nullable().optional(),
  sundayMbkSingle: z.boolean().optional(),
  mbkLean: z.boolean().optional(),
  leanPick: z.object({ wed: z.string().nullable().optional(), thu: z.string().nullable().optional(), sun: z.string().nullable().optional() }).optional(),
  payday: z.array(z.number()).optional(),
});

/** Contexto para armar el horario de una tienda/semana: equipo, cobertura sugerida y
 * el plan ya guardado (si existe). */
export const getScheduleContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const { store, prodBudget, mbkBudget } = await loadStoreCtx(context.userId, data.storeId);
    const team = await loadTeam(data.storeId);
    // Cobertura basada en AGENTES REALES a caja (activos, sin puesto APOYO), para no pedir
    // turnos que nadie puede cubrir. Se conserva el presupuesto solo como referencia.
    const prodHC = team.filter((p) => p.area === "PRODUCTOS" && isCajaHC(p)).length;
    const mbkHC = team.filter((p) => p.area === "MBK" && isCajaHC(p)).length;

    // Plan existente para esa semana (borrador o aprobado).
    const { data: existing } = await supabaseAdmin
      .from("schedules")
      .select("id, status, coverage, approved_at, schedule_shifts(employee_id, day_index, shift_key, role, flags)")
      .eq("store_id", data.storeId).eq("week_start", data.weekStart).maybeSingle();

    // ¿Hay algún horario APROBADO de una semana anterior? Si no, es el primer horario y la
    // UI debe pedir quién cerró el domingo noche pasado (semilla del descanso dom→lun).
    const { data: prior } = await supabaseAdmin
      .from("schedules")
      .select("id").eq("store_id", data.storeId).eq("status", "approved").lt("week_start", data.weekStart).limit(1);

    return {
      store: { id: store.id, code: store.code, name: store.name, prodHC, mbkHC, prodBudget, mbkBudget },
      team,
      suggested: suggestedCoverage(prodHC, mbkHC, data.weekStart, {}),
      existing: existing ?? null,
      hasPriorApproved: (prior?.length ?? 0) > 0,
    };
  });

/** Genera el horario con el motor (respeta la cobertura del GT + el historial aprobado). */
export const generateSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      coverage: coverageSchema,
      domPrev: z.array(z.string().uuid()).max(60).optional(),
      attempts: z.number().int().min(1).max(300).optional(),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    await loadStoreCtx(context.userId, data.storeId);
    const team = await loadTeam(data.storeId);
    if (!team.length) throw new Error("La tienda no tiene cajeros ni agentes MBK activos");
    // Cobertura/factibilidad sobre agentes REALES a caja (sin puesto APOYO).
    const prodHC = team.filter((p) => p.area === "PRODUCTOS" && isCajaHC(p)).length;
    const mbkHC = team.filter((p) => p.area === "MBK" && isCajaHC(p)).length;
    // Semilla del descanso dom→lun para el primer horario (quién cerró domingo noche pasado).
    if (data.domPrev?.length) { const set = new Set(data.domPrev); team.forEach((p) => { if (set.has(p.id)) p.domPrev = true; }); }
    const history = await loadHistory(data.storeId, data.weekStart);

    const out = generate({
      people: team,
      coverage: data.coverage as Coverage,
      weekStart: data.weekStart,
      prodHC, mbkHC, history,
      attempts: data.attempts ?? 5000,   // tope alto; en la práctica lo limita el presupuesto de tiempo
      timeBudgetMs: 8000,                 // seguro bajo el timeout serverless (~10s)
      improveMsPerRestart: 300,           // búsqueda local (hill climbing) por reinicio
    });
    return { schedule: out.schedule, alerts: out.alerts, penalty: out.penalty, combos: out.combos ?? 0, restarts: out.restarts ?? 0 };
  });

/** Guarda el plan (borrador o aprobado) en schedules + schedule_shifts. */
export const saveSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      storeId: z.string().uuid(),
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      coverage: coverageSchema,
      status: z.enum(["draft", "approved"]),
      assignments: z.array(z.object({
        employee_id: z.string().uuid(),
        day_index: z.number().int().min(0).max(6),
        shift_key: z.enum(["PROD_AM", "PROD_PM", "MBK_AM", "MBK_PM"]),
        role: z.enum(["CAJA", "APOYO"]).default("CAJA"),
        flags: z.record(z.string(), z.any()).optional(),
      })).max(400),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    await loadStoreCtx(context.userId, data.storeId);

    // Backstop de servidor: NO se aprueba un plan que viole reglas duras. Se revalida con
    // el motor (incluye historial: descanso dom→lun) sobre lo que realmente se va a guardar.
    // El cliente puede editar a mano, pero el servidor es la autoridad de la aprobación.
    if (data.status === "approved") {
      if (!data.assignments.length) throw new Error("No puedes aprobar un horario vacío.");
      const team = await loadTeam(data.storeId);
      const teamIds = new Set(team.map((p) => p.id));
      if (data.assignments.some((a) => !teamIds.has(a.employee_id)))
        throw new Error("El plan referencia a un colaborador que no está activo en la tienda.");
      const prodHC = team.filter((p) => p.area === "PRODUCTOS" && isCajaHC(p)).length;
      const mbkHC = team.filter((p) => p.area === "MBK" && isCajaHC(p)).length;
      const history = await loadHistory(data.storeId, data.weekStart);
      const grid = {} as Schedule;
      SHIFT_KEYS.forEach((k) => { grid[k] = Array.from({ length: 7 }, () => [] as Assignment[]); });
      for (const a of data.assignments) {
        // id/role SIEMPRE de los campos validados (nunca de flags, para que un payload no los suplante).
        const assign: Assignment = { id: a.employee_id, role: a.role };
        const f = (a.flags || {}) as Record<string, unknown>;
        if (f.supportFrom === "PRODUCTOS") assign.supportFrom = "PRODUCTOS";
        if (typeof f.exception === "string") assign.exception = f.exception; // necesario para el flujo honesto (nuevoException)
        grid[a.shift_key as ShiftKey][a.day_index].push(assign);
      }
      const reds = validate({ people: team, coverage: data.coverage as Coverage, weekStart: data.weekStart, prodHC, mbkHC, history }, grid).filter((al) => al.level === "bad");
      if (reds.length) throw new Error(`No se puede aprobar: ${reds.length} regla(s) crítica(s). ${reds[0].text}`);
    }

    const nowIso = new Date().toISOString();
    const { data: sched, error: upErr } = await supabaseAdmin
      .from("schedules")
      .upsert({
        store_id: data.storeId, week_start: data.weekStart,
        coverage: data.coverage as unknown as Json,
        status: data.status, created_by: context.userId,
        approved_at: data.status === "approved" ? nowIso : null,
        approved_by: data.status === "approved" ? context.userId : null,
      }, { onConflict: "store_id,week_start" })
      .select("id").single();
    if (upErr || !sched) throw new Error(upErr?.message || "No se pudo guardar el plan");

    // Reemplazar asignaciones.
    await supabaseAdmin.from("schedule_shifts").delete().eq("schedule_id", sched.id);
    if (data.assignments.length) {
      const rows = data.assignments.map((a) => ({
        schedule_id: sched.id, employee_id: a.employee_id, day_index: a.day_index,
        shift_key: a.shift_key, role: a.role, flags: a.flags ?? {},
      }));
      const { error: insErr } = await supabaseAdmin.from("schedule_shifts").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    return { ok: true as const, scheduleId: sched.id, status: data.status };
  });

/** Edita los atributos de horario de un colaborador (puesto, estudia, etc.). */
export const setEmployeeScheduleAttrs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      id: z.string().uuid(),
      puesto_horario: z.enum(["AGENTE", "APOYO", "NUEVO", "PASANTE", "SASA"]).optional(),
      estudia: z.string().max(16).optional(),
      no_disponible: z.string().max(120).optional(),
      horas_meta: z.number().int().min(8).max(60).optional(),
      apoya_mbk: z.boolean().optional(),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    const scope = await getScope(context.userId);
    const { data: emp } = await supabaseAdmin.from("employees").select("store_id").eq("id", data.id).maybeSingle();
    if (!emp) throw new Error("Colaborador no encontrado");
    if (scope.storeIds !== "all" && !scope.storeIds.includes(emp.store_id as string))
      throw new Error("Sin acceso a este colaborador");
    const patch: {
      puesto_horario?: string; estudia?: string | null; no_disponible?: string | null;
      horas_meta?: number; apoya_mbk?: boolean;
    } = {};
    if (data.puesto_horario !== undefined) patch.puesto_horario = data.puesto_horario;
    if (data.estudia !== undefined) patch.estudia = data.estudia || null;
    if (data.no_disponible !== undefined) patch.no_disponible = data.no_disponible || null;
    if (data.horas_meta !== undefined) patch.horas_meta = data.horas_meta;
    if (data.apoya_mbk !== undefined) patch.apoya_mbk = data.apoya_mbk;
    if (Object.keys(patch).length) {
      const { error } = await supabaseAdmin.from("employees").update(patch).eq("id", data.id);
      if (error) throw new Error(error.message);
    }
    return { ok: true as const };
  });
