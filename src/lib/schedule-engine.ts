// Motor de generación de horarios (port del generador HTML v9.4, framework-agnóstico).
// Puro: sin estado global ni DOM. Se usa desde una server function. Reglas de negocio:
//  - Productos: turnos 12h (AM 6-18, PM 18-6), meta 4 turnos = 48h.
//  - MBK: turnos 8h (AM 6-14, PM 14-22), meta 6 turnos = 48h.
//  - 1 turno por persona/día; no AM tras PM nocturno; máx 3 noches y sin 2 seguidas;
//    ancla de noche para el Nuevo; estudiantes; descanso domingo-noche→lunes;
//    solo MBK/calificado cubre Bankito; la cobertura del GT es obligatoria.

export type ShiftKey = "PROD_AM" | "PROD_PM" | "MBK_AM" | "MBK_PM";
export type Area = "PRODUCTOS" | "MBK";
export type Puesto = "AGENTE" | "APOYO" | "NUEVO" | "PASANTE" | "SASA";

export interface SchedPerson {
  id: string;
  nombre: string;
  area: Area;
  puesto: Puesto;
  mbkQ: boolean;          // Productos calificado para cubrir MBK (apoya_mbk)
  estudia: "" | "Sábado" | "Domingo";
  noDisponible: string;   // "Viernes, Sábado"
  horasMeta: number;      // 48
  domPrev?: boolean;      // cerró domingo noche la semana previa (semilla, primer horario)
}

export interface Coverage {
  PROD_AM: number[]; PROD_PM: number[]; MBK_AM: number[]; MBK_PM: number[];
  mbkOff?: number | null;
  sundayMbkSingle?: boolean;
  mbkLean?: boolean;
  leanPick?: { wed?: string | null; thu?: string | null; sun?: string | null };
  payday?: number[];
}

export interface Assignment {
  id: string;
  role: "CAJA" | "APOYO";
  supportFrom?: string | null;
  contingency?: boolean;
  exception?: string;
  intercambio?: boolean;
  fromArea?: string;
}
export type Schedule = Record<ShiftKey, Assignment[][]>; // [shiftKey][0..6] = asignaciones
export interface Alert { level: "ok" | "warn" | "bad"; type: string; text: string }
// Historial aprobado: nombres por turno/día para reglas de repetición y descanso.
export interface HistoryEntry { weekStart: string; flat: Record<ShiftKey, string[][]> }

export interface GenInput {
  people: SchedPerson[];
  coverage: Coverage;
  weekStart: string;      // yyyy-mm-dd (lunes)
  prodHC: number;
  mbkHC: number;
  history?: HistoryEntry[];
  attempts?: number;
  timeBudgetMs?: number;
  /** Si viene, NO se genera: se valida ESTE horario (para revalidar ediciones manuales). */
  validateOnly?: Schedule;
}
export interface GenOutput { schedule: Schedule; alerts: Alert[]; penalty: number }

export const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
export const SHIFT_KEYS: ShiftKey[] = ["PROD_AM", "PROD_PM", "MBK_AM", "MBK_PM"];
export const SHIFT_DEF: Record<ShiftKey, { area: Area; short: string; hours: number }> = {
  PROD_AM: { area: "PRODUCTOS", short: "Prod AM", hours: 12 },
  PROD_PM: { area: "PRODUCTOS", short: "Prod PM", hours: 12 },
  MBK_AM: { area: "MBK", short: "MBK AM", hours: 8 },
  MBK_PM: { area: "MBK", short: "MBK PM", hours: 8 },
};
const MAX_NIGHTS = 3;
const PAYDAY_DATES = [15, 20, 30];

function isoToDate(iso: string) { return new Date(iso + "T00:00:00Z"); }
export function addDaysIso(iso: string, n: number) { const d = isoToDate(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function paydayPeakDays(weekStart: string): number[] {
  const out: number[] = []; if (!weekStart) return out;
  for (let i = 0; i < 7; i++) { const dt = isoToDate(addDaysIso(weekStart, i)); if (PAYDAY_DATES.includes(dt.getUTCDate())) out.push(i); }
  return out;
}
const parseList = (t: string) => String(t || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Cobertura sugerida (punto de partida editable). Sin venta/tx: usa prodHC/mbkHC + payday
 * + opciones manuales (domingo reducido, esquema eficiente). */
export function suggestedCoverage(prodHC: number, mbkHC: number, weekStart: string, opts: { sundayMbkSingle?: boolean; mbkLean?: boolean; leanPick?: Coverage["leanPick"]; mbkOff?: number | null } = {}): Coverage {
  const prod = prodHC, mbk = mbkHC;
  const prodAM = Array(7).fill(1), prodPM = Array(7).fill(prod <= 5 ? 1 : 2);
  let mbkAM = Array(7).fill(0), mbkPM = Array(7).fill(0);
  let mbkOff: number | null = opts.mbkOff ?? null;

  if (prod >= 7) { [0, 4, 5, 6].forEach((d) => { prodAM[d] = 2; prodPM[d] = 2; }); }
  else if (prod === 6) { /* AM 1, PM 2 */ }
  else { prodPM.fill(1); }

  if (prod <= 5) { if (mbkOff == null) mbkOff = [2, 3][Math.floor(Math.random() * 2)]; mbkAM = Array(7).fill(1); mbkAM[mbkOff] = 0; }
  else if (mbk >= 4) { mbkAM = [2, 1, 1, 1, 2, 2, 1]; mbkPM = [2, 2, 2, 2, 2, 2, 1]; }
  else if (mbk === 3) { mbkAM = Array(7).fill(1); mbkPM = Array(7).fill(1); [0, 4, 5].forEach((d) => (mbkPM[d] = 2)); }
  else if (mbk === 2) { mbkAM = Array(7).fill(1); mbkPM = Array(7).fill(1); }
  else if (mbk === 1) { if (mbkOff == null) mbkOff = [2, 3][Math.floor(Math.random() * 2)]; mbkAM = Array(7).fill(1); mbkAM[mbkOff] = 0; }

  const peakAM_P = Math.max(...prodAM), peakPM_P = Math.max(...prodPM);
  const peakAM_M = Math.max(...mbkAM), peakPM_M = Math.max(...mbkPM);
  paydayPeakDays(weekStart).forEach((d) => {
    prodAM[d] = Math.max(prodAM[d], peakAM_P); prodPM[d] = Math.max(prodPM[d], peakPM_P);
    if (!(prod <= 5 && d === mbkOff)) mbkAM[d] = Math.max(mbkAM[d], peakAM_M);
    if (!(prod <= 5)) mbkPM[d] = Math.max(mbkPM[d], peakPM_M);
  });

  const protPM = prod > 5;
  if (opts.sundayMbkSingle) { if (protPM) { mbkAM[6] = 0; mbkPM[6] = 1; } else { mbkAM[6] = 1; mbkPM[6] = 0; } }
  if (opts.mbkLean) {
    [0, 1, 4, 5].forEach((d) => { mbkAM[d] = 2; mbkPM[d] = 2; });
    mbkAM[2] = 0; mbkPM[2] = 1; mbkAM[3] = 0; mbkPM[3] = 1; mbkAM[6] = 0; mbkPM[6] = 1;
  }
  // Factibilidad MBK (descanso Mié/Jue → entre esos días solo hay tantos turnos como personas).
  for (let d = 0; d < 7; d++) { while (mbkAM[d] + mbkPM[d] > mbk) { if (mbkAM[d] > 0) mbkAM[d]--; else if (mbkPM[d] > 0) mbkPM[d]--; else break; } }

  return { PROD_AM: prodAM, PROD_PM: prodPM, MBK_AM: mbkAM, MBK_PM: mbkPM, mbkOff, sundayMbkSingle: !!opts.sundayMbkSingle, mbkLean: !!opts.mbkLean, leanPick: opts.leanPick || {}, payday: paydayPeakDays(weekStart) };
}

/** Genera el horario. Corre varios intentos (el motor tiene aleatoriedad) y conserva el
 * de menor penalización, con presupuesto de tiempo para no bloquear el servidor. */
export function generate(input: GenInput): GenOutput {
  const people = input.people;
  const cov = input.coverage;
  const weekStart = input.weekStart;
  const PRODHC = input.prodHC;
  const history = input.history || [];

  const buildEmpty = (): Schedule => {
    const o = {} as Schedule;
    SHIFT_KEYS.forEach((k) => { o[k] = Array.from({ length: 7 }, () => [] as Assignment[]); });
    return o;
  };
  let schedule: Schedule = buildEmpty();

  const getPerson = (id: string) => people.find((x) => x.id === id);
  const cajaCount = (k: ShiftKey, d: number) => schedule[k][d].filter((it) => it.role !== "APOYO").length;
  const assignmentsOf = (id: string) => {
    const out: Array<{ shiftKey: ShiftKey; dayIndex: number; meta: Assignment }> = [];
    SHIFT_KEYS.forEach((k) => schedule[k].forEach((arr, d) => arr.forEach((it) => { if (it.id === id) out.push({ shiftKey: k, dayIndex: d, meta: it }); })));
    return out;
  };
  const effHours = (a: { shiftKey: ShiftKey; meta: Assignment }) => (a.meta.supportFrom === "PRODUCTOS" ? 12 : SHIFT_DEF[a.shiftKey].hours);
  const personHours = (id: string) => assignmentsOf(id).reduce((s, a) => s + effHours(a), 0);
  const personCounts = (id: string) => {
    const a = assignmentsOf(id);
    return {
      am: a.filter((x) => x.shiftKey.endsWith("AM")).length, pm: a.filter((x) => x.shiftKey.endsWith("PM")).length,
      prodAM: a.filter((x) => x.shiftKey === "PROD_AM" || (x.shiftKey === "MBK_AM" && x.meta.supportFrom)).length,
      prodPM: a.filter((x) => x.shiftKey === "PROD_PM" || (x.shiftKey === "MBK_PM" && x.meta.supportFrom)).length,
      mbkAM: a.filter((x) => x.shiftKey === "MBK_AM" && !x.meta.supportFrom).length,
      mbkPM: a.filter((x) => x.shiftKey === "MBK_PM" && !x.meta.supportFrom).length,
      mbkTurns: a.filter((x) => x.shiftKey.startsWith("MBK") && !x.meta.supportFrom).length,
      prodTurns: a.filter((x) => x.shiftKey.startsWith("PROD") || x.meta.supportFrom === "PRODUCTOS").length,
      total: a.length,
    };
  };
  const restricted = (p: SchedPerson, d: number, k: ShiftKey) => {
    const day = DAYS[d], list = parseList(p.noDisponible);
    if (list.includes(day)) return true;
    if (p.estudia === "Sábado") { if (day === "Sábado") return true; if (day === "Viernes" && k.endsWith("PM")) return true; }
    if (p.estudia === "Domingo") { if (day === "Domingo") return true; if (day === "Sábado" && k.endsWith("PM")) return true; }
    return false;
  };
  const hasAnyShift = (id: string, d: number) => assignmentsOf(id).some((a) => a.dayIndex === d);
  const workedPrevPM = (id: string, d: number) => d > 0 && assignmentsOf(id).some((a) => a.dayIndex === d - 1 && a.shiftKey.endsWith("PM"));
  const nightCount = (id: string) => assignmentsOf(id).filter((a) => a.shiftKey === "PROD_PM").length;
  const prodPMon = (id: string, d: number) => d >= 0 && d <= 6 && assignmentsOf(id).some((a) => a.dayIndex === d && a.shiftKey === "PROD_PM");
  const hasNextDayAM = (id: string, d: number) => d < 6 && assignmentsOf(id).some((a) => a.dayIndex === d + 1 && a.shiftKey.endsWith("AM"));
  const isSupportRole = (p: SchedPerson) => p.puesto === "APOYO";
  const isNightAnchor = (q?: SchedPerson) => !!q && (q.puesto === "AGENTE" || q.puesto === "SASA");
  const cellHasAnchor = (k: ShiftKey, d: number) => schedule[k][d].some((it) => it.role !== "APOYO" && isNightAnchor(getPerson(it.id)));

  // Historial
  const previousWeekApproved = () => history.find((r) => r.weekStart === addDaysIso(weekStart, -7)) || null;
  const recentApproved = (limit = 3) => history.filter((r) => r.weekStart < weekStart).sort((a, b) => b.weekStart.localeCompare(a.weekStart)).slice(0, limit);
  const prevWeekSundayPM = (name: string) => {
    const rec = previousWeekApproved();
    if (rec) return (["PROD_PM", "MBK_PM"] as ShiftKey[]).some((k) => (rec.flat?.[k]?.[6] || []).includes(name));
    const p = people.find((x) => (x.nombre || "").trim() === String(name).trim());
    return !!(p && p.domPrev);
  };
  const histRepeat = (name: string, d: number, k: ShiftKey) => recentApproved(3).reduce((acc, r) => acc + ((r.flat?.[k]?.[d] || []).includes(name) ? 1 : 0), 0);

  // Días reducidos (descanso permitido para el resto)
  const sundaySingle = () => !!cov.sundayMbkSingle;
  const leanMode = () => !!cov.mbkLean;
  const leanDays = () => (leanMode() ? [2, 3, 6] : (sundaySingle() ? [6] : []));
  const MBK_MANDATORY = [0, 1, 4, 5, 6];
  const MBK_FLEX = [2, 3];

  const mbkCellAllowed = (d: number, k: ShiftKey) => {
    if (PRODHC <= 5) {
      if (k === "MBK_PM") return false;
      if (cov.mbkOff != null && d === cov.mbkOff) return false;
    }
    return true;
  };

  const canProduct = (p: SchedPerson, d: number, k: ShiftKey, opt: { cont?: boolean } = {}) => {
    if (p.area !== "PRODUCTOS") return false;
    if (isSupportRole(p)) return false;
    if (restricted(p, d, k)) return false;
    if (hasAnyShift(p.id, d)) return false;
    const meta = Number(p.horasMeta || 48);
    if (personHours(p.id) + 12 > meta + (opt.cont ? 12 : 0)) return false;
    if (workedPrevPM(p.id, d)) return false;
    if (k === "PROD_PM" && hasNextDayAM(p.id, d)) return false;
    if (k === "PROD_PM" && nightCount(p.id) >= MAX_NIGHTS) return false;
    if (k === "PROD_PM" && (prodPMon(p.id, d - 1) || prodPMon(p.id, d + 1))) return false;
    if (k === "PROD_PM" && p.puesto === "NUEVO" && !cellHasAnchor("PROD_PM", d)) return false;
    if (d === 0 && prevWeekSundayPM(p.nombre)) return false;
    return true;
  };
  const canMBK = (p: SchedPerson, d: number, k: ShiftKey, opt: { support?: boolean; cont?: boolean } = {}) => {
    const isSupport = !!opt.support && p.area === "PRODUCTOS";
    if (!(p.area === "MBK" || isSupport)) return false;
    if (isSupport && !p.mbkQ) return false;
    if (isSupportRole(p)) return false;
    if (!mbkCellAllowed(d, k)) return false;
    if (restricted(p, d, k)) return false;
    if (hasAnyShift(p.id, d)) return false;
    const meta = Number(p.horasMeta || 48), h = isSupport ? 12 : SHIFT_DEF[k].hours;
    if (personHours(p.id) + h > meta + (opt.cont ? h : 0)) return false;
    if (p.area === "PRODUCTOS" && workedPrevPM(p.id, d)) return false;
    if (d === 0 && k === "MBK_AM" && prevWeekSundayPM(p.nombre)) return false;
    return true;
  };
  const canApoyo = (p: SchedPerson, d: number, k: ShiftKey) => {
    if (restricted(p, d, k)) return false;
    if (hasAnyShift(p.id, d)) return false;
    if (personHours(p.id) + SHIFT_DEF[k].hours > Number(p.horasMeta || 48)) return false;
    if (k.endsWith("AM") && workedPrevPM(p.id, d)) return false;
    if (k === "PROD_PM" && hasNextDayAM(p.id, d)) return false;
    if (k === "PROD_PM" && nightCount(p.id) >= MAX_NIGHTS) return false;
    if (k === "PROD_PM" && (prodPMon(p.id, d - 1) || prodPMon(p.id, d + 1))) return false;
    if (d === 0 && prevWeekSundayPM(p.nombre)) return false;
    return true;
  };

  const scoreProduct = (p: SchedPerson, d: number, k: ShiftKey) => {
    const c = personCounts(p.id); let s = 300 - personHours(p.id);
    if (k === "PROD_PM") s += (2 - c.prodPM) * 70;
    if (k === "PROD_AM") s += (2 - c.prodAM) * 60;
    if (k === "PROD_PM") { if (p.puesto === "AGENTE") s += 45; if (p.puesto === "NUEVO") s -= 35; if (p.puesto === "SASA") s -= 12; }
    s -= histRepeat(p.nombre, d, k) * 22;
    if (p.puesto === "NUEVO" && k === "PROD_AM") s += 8;
    if (prevWeekSundayPM(p.nombre)) { if (d === 1 && k === "PROD_AM") s += 40; if (d === 1 && k === "PROD_PM") s -= 40; }
    s += Math.random() * 12; return s;
  };
  const scoreMBK = (p: SchedPerson, d: number, k: ShiftKey, opt: { support?: boolean } = {}) => {
    const c = personCounts(p.id); let s = 300 - personHours(p.id);
    if (p.area === "MBK") s += 100;
    if (k === "MBK_AM") s += (3 - c.mbkAM) * 45;
    if (k === "MBK_PM") s += (3 - c.mbkPM) * 45;
    if (p.area === "MBK") s += (6 - c.mbkTurns) * 35;
    if (opt.support && p.area === "PRODUCTOS") s -= 70;
    s -= histRepeat(p.nombre, d, k) * 20;
    s += Math.random() * 12; return s;
  };
  const bestProduct = (d: number, k: ShiftKey, opt: { cont?: boolean }) => people.filter((p) => canProduct(p, d, k, opt)).sort((a, b) => scoreProduct(b, d, k) - scoreProduct(a, d, k))[0] || null;
  const bestMBK = (d: number, k: ShiftKey, opt: { support?: boolean; cont?: boolean }) => people.filter((p) => canMBK(p, d, k, opt)).sort((a, b) => scoreMBK(b, d, k, opt) - scoreMBK(a, d, k, opt))[0] || null;
  const place = (k: ShiftKey, d: number, p: SchedPerson, meta: Partial<Assignment> = {}) => { schedule[k][d].push({ id: p.id, role: "CAJA", supportFrom: null, contingency: false, ...meta }); };
  const placeApoyo = (p: SchedPerson, d: number) => {
    const prefix = p.area === "MBK" ? "MBK_" : "PROD_";
    const c = personCounts(p.id);
    const blocks = c.am <= c.pm ? ["AM", "PM"] : ["PM", "AM"];
    for (const b of blocks) { const k = (prefix + b) as ShiftKey; if (canApoyo(p, d, k)) { place(k, d, p, { role: "APOYO" }); return true; } }
    return false;
  };

  const leanRotation = (ppl: SchedPerson[]) => {
    const pick = cov.leanPick || {};
    const shiftOf = (d: number): ShiftKey => (cov.MBK_PM[d] > 0 ? "MBK_PM" : "MBK_AM");
    const sunK = shiftOf(6);
    const n = ppl.length || 1;
    const wk = weekStart ? Math.floor(isoToDate(weekStart).getTime() / 86400000 / 7) : 0;
    const off = ((wk % n) + n) % n;
    const auto: Record<number, string | undefined> = { 2: ppl[off]?.id, 3: ppl[(off + 1) % n]?.id, 6: ppl[(off + 2) % n]?.id };
    const valid = (id: string, d: number, k: ShiftKey) => { const p = ppl.find((x) => x.id === id); return !!p && !restricted(p, d, k); };
    const res: Record<number | "sunK", string | ShiftKey | undefined> = { sunK } as never;
    (res as never as Record<number, string | undefined>)[2] = (pick.wed && valid(pick.wed, 2, shiftOf(2))) ? pick.wed : auto[2];
    (res as never as Record<number, string | undefined>)[3] = (pick.thu && valid(pick.thu, 3, shiftOf(3))) ? pick.thu : auto[3];
    (res as never as Record<number, string | undefined>)[6] = (pick.sun && valid(pick.sun, 6, sunK)) ? pick.sun : auto[6];
    return res as { sunK: ShiftKey; 2?: string; 3?: string; 6?: string };
  };

  const fillMBK = () => {
    const ppl = people.filter((p) => p.area === "MBK" && !isSupportRole(p));
    if (leanMode() && cov.leanPick) {
      const rot = leanRotation(ppl);
      [2, 3, 6].forEach((d) => { const pid = (rot as Record<number, string | undefined>)[d]; if (!pid) return;
        const k: ShiftKey | null = cov.MBK_PM[d] > 0 ? "MBK_PM" : (cov.MBK_AM[d] > 0 ? "MBK_AM" : null);
        if (k) { const p = ppl.find((x) => x.id === pid); if (p && !hasAnyShift(p.id, d) && cajaCount(k, d) < cov[k][d] && canMBK(p, d, k, {})) place(k, d, p, {}); }
      });
    }
    (["MBK_PM", "MBK_AM"] as ShiftKey[]).forEach((k) => { for (let d = 0; d < 7; d++) { while (cajaCount(k, d) < cov[k][d]) { const p = bestMBK(d, k, {}); if (!p) break; place(k, d, p, {}); } } });
    (["MBK_PM", "MBK_AM"] as ShiftKey[]).forEach((k) => { for (let d = 0; d < 7; d++) {
      if (!mbkCellAllowed(d, k)) continue;
      while (cajaCount(k, d) < cov[k][d]) {
        let p = bestMBK(d, k, { cont: true });
        if (!p) p = bestMBK(d, k, { support: true });
        if (!p) p = bestMBK(d, k, { support: true, cont: true });
        if (!p) break;
        const over = personHours(p.id) + (p.area === "PRODUCTOS" ? 12 : SHIFT_DEF[k].hours) > Number(p.horasMeta || 48);
        place(k, d, p, p.area === "PRODUCTOS" ? { supportFrom: "PRODUCTOS", contingency: over } : { contingency: over });
      }
    } });
  };
  const fillProductos = () => {
    const ppl = people.filter((p) => p.area === "PRODUCTOS" && !isSupportRole(p));
    const cnt = (p: SchedPerson, k: ShiftKey) => (k === "PROD_PM" ? personCounts(p.id).prodPM : personCounts(p.id).prodAM);
    const eligN = (k: ShiftKey, d: number) => ppl.filter((p) => canProduct(p, d, k, {})).length;
    const place1 = (k: ShiftKey, d: number, maxType: number) => {
      let best: SchedPerson | null = null, bs = -1e9;
      ppl.forEach((p) => { if (cnt(p, k) >= maxType) return; if (!canProduct(p, d, k, {})) return; const sc = scoreProduct(p, d, k); if (sc > bs) { bs = sc; best = p; } });
      if (best) { place(k, d, best, {}); return true; } return false;
    };
    for (let round = 1; round <= 2; round++) {
      [...Array(7).keys()].sort((a, b) => eligN("PROD_PM", a) - eligN("PROD_PM", b))
        .forEach((d) => { let g = 0; while (cajaCount("PROD_PM", d) < cov.PROD_PM[d] && g++ < 8 && place1("PROD_PM", d, round)) { /* fill */ } });
      [...Array(7).keys()].sort((a, b) => eligN("PROD_AM", a) - eligN("PROD_AM", b))
        .forEach((d) => { let g = 0; while (cajaCount("PROD_AM", d) < cov.PROD_AM[d] && g++ < 8 && place1("PROD_AM", d, round)) { /* fill */ } });
    }
  };
  const completeProductos = () => {
    const pplF = () => people.filter((p) => p.area === "PRODUCTOS" && !isSupportRole(p));
    const under = () => pplF().filter((p) => personCounts(p.id).prodTurns < Math.round(Number(p.horasMeta || 48) / 12) && personHours(p.id) < Number(p.horasMeta || 48));
    let guard = 0;
    while (guard++ < 60) {
      const us = under(); if (!us.length) break;
      let progress = false;
      us.sort((a, b) => personCounts(a.id).prodTurns - personCounts(b.id).prodTurns).forEach((p) => {
        for (const k of ["PROD_PM", "PROD_AM"] as ShiftKey[]) for (let d = 0; d < 7; d++) {
          if (cajaCount(k, d) >= cov[k][d]) continue;
          if (canProduct(p, d, k, {})) { place(k, d, p, {}); progress = true; return; }
        }
      });
      if (!progress) break;
    }
    guard = 0;
    while (guard++ < 40) {
      const us = under(); if (!us.length) break;
      let moved = false;
      for (const p of us) {
        let done = false;
        for (const k of ["PROD_PM", "PROD_AM"] as ShiftKey[]) { for (let d = 0; d < 7 && !done; d++) {
          if (cajaCount(k, d) < cov[k][d]) continue;
          if (hasAnyShift(p.id, d)) continue;
          if (restricted(p, d, k)) continue;
          const cell = schedule[k][d];
          for (let i = 0; i < cell.length; i++) {
            const occ = getPerson(cell[i].id); if (!occ || cell[i].role === "APOYO" || isSupportRole(occ)) continue;
            let dest: { k2: ShiftKey; d2: number } | null = null;
            for (const k2 of ["PROD_PM", "PROD_AM"] as ShiftKey[]) for (let d2 = 0; d2 < 7; d2++) {
              if (d2 === d) continue;
              if (cajaCount(k2, d2) >= cov[k2][d2]) continue;
              if (!hasAnyShift(occ.id, d2) && canProduct(occ, d2, k2, {})) { dest = { k2, d2 }; break; }
            }
            if (!dest) continue;
            const removed = cell.splice(i, 1)[0];
            if (canProduct(p, d, k, {})) { place(k, d, p, {}); place(dest.k2, dest.d2, occ, {}); moved = true; done = true; break; }
            else { cell.splice(i, 0, removed); }
          }
        } }
      }
      if (!moved) break;
    }
  };
  const fillSupportRoles = () => {
    const sup = people.filter(isSupportRole);
    sup.forEach((p) => {
      const target = Math.round(Number(p.horasMeta || 48) / (p.area === "MBK" ? 8 : 12));
      const dayOrder = p.area === "MBK" ? [...MBK_MANDATORY, ...MBK_FLEX] : [4, 5, 6, 0, 1, 2, 3];
      let guard = 0;
      while (personCounts(p.id).total < target && guard++ < 14) {
        let placed = false;
        for (const d of dayOrder) { if (!hasAnyShift(p.id, d) && placeApoyo(p, d)) { placed = true; break; } }
        if (!placed) break;
      }
    });
  };
  const buildOneCandidate = () => { schedule = buildEmpty(); fillMBK(); fillProductos(); completeProductos(); fillSupportRoles(); };

  // Validación / alertas (subset del original: reglas duras y advertencias principales)
  const computeAlerts = (): Alert[] => {
    const alerts: Alert[] = [];
    SHIFT_KEYS.forEach((k) => cov[k].forEach((req, d) => {
      const have = cajaCount(k, d);
      if (have < req) {
        alerts.push({ level: "warn", type: "cover", text: `Falta cubrir ${req - have} en ${SHIFT_DEF[k].short} / ${DAYS[d]} (requerido ${req}, asignado ${have}).` });
        if (req - have >= 2) alerts.push({ level: "warn", type: "clustergap", text: `${SHIFT_DEF[k].short} / ${DAYS[d]} quedó con 2 faltantes el mismo día.` });
      }
    }));
    people.forEach((p) => {
      const h = personHours(p.id), meta = Number(p.horasMeta || 48), c = personCounts(p.id), arr = assignmentsOf(p.id);
      if (h < meta) { const ut = (leanMode() && p.area === "MBK") ? "leanhours" : (p.area === "PRODUCTOS" && !isSupportRole(p)) ? "underprod" : "under";
        alerts.push({ level: "warn", type: ut, text: ut === "leanhours" ? `${p.nombre} (MBK) trabaja ${h}h (esquema eficiente).` : `${p.nombre} quedó en ${h}h de ${meta}h meta.` }); }
      if (h > meta) alerts.push({ level: "warn", type: "over", text: `${p.nombre} trabaja ${h}h (${h - meta}h extra sobre ${meta}h).` });
      if (p.area === "PRODUCTOS" && PRODHC >= 7 && !isSupportRole(p) && (c.prodAM !== 2 || c.prodPM !== 2) && !arr.some((a) => a.meta.supportFrom))
        alerts.push({ level: "warn", type: "pattern7", text: `${p.nombre} no cumple 2 AM + 2 PM (AM:${c.prodAM}/PM:${c.prodPM}).` });
      if (p.area === "MBK" && !isSupportRole(p) && PRODHC > 5 && c.mbkTurns < 6)
        alerts.push({ level: "warn", type: "mbk6", text: `${p.nombre} (MBK) quedó con ${c.mbkTurns} de 6 turnos.` });
      if (arr.some((a) => a.meta.role === "APOYO")) alerts.push({ level: "warn", type: "apoyo", text: `${p.nombre} tiene turno(s) de apoyo.` });
      if (arr.some((a) => a.meta.supportFrom)) alerts.push({ level: "warn", type: "support", text: `${p.nombre} apoyó a MBK (cruzado).` });
      arr.forEach((a) => { if (restricted(p, a.dayIndex, a.shiftKey) && !a.meta.exception) alerts.push({ level: "bad", type: "restr", text: `${p.nombre} asignado en restricción (${DAYS[a.dayIndex]} / ${SHIFT_DEF[a.shiftKey].short}).` }); });
      const dias: Record<number, number> = {}; arr.forEach((a) => { dias[a.dayIndex] = (dias[a.dayIndex] || 0) + 1; });
      Object.keys(dias).filter((d) => dias[+d] > 1).forEach((d) => alerts.push({ level: "bad", type: "doblete", text: `${p.nombre} tiene DOBLETE el ${DAYS[+d]} (AM+PM): imposible, 1 turno por día.` }));
      // Área: nadie debe estar en un turno de otra área, salvo Productos cruzado a MBK (con supportFrom).
      arr.forEach((a) => { const sa = SHIFT_DEF[a.shiftKey].area; if (p.area !== sa && !(p.area === "PRODUCTOS" && sa === "MBK" && a.meta.supportFrom === "PRODUCTOS" && p.mbkQ)) alerts.push({ level: "bad", type: "area", text: `${p.nombre} (${p.area === "MBK" ? "MBK" : "Productos"}) asignado a ${SHIFT_DEF[a.shiftKey].short}, que es de otra área${p.area === "PRODUCTOS" && sa === "MBK" && !p.mbkQ ? " (sin calificación para Bankito)" : ""}.` }); });
      if (p.area === "PRODUCTOS") {
        const nights = arr.filter((a) => a.shiftKey === "PROD_PM").map((a) => a.dayIndex).sort((x, y) => x - y);
        if (nights.length > MAX_NIGHTS) alerts.push({ level: "bad", type: "nights", text: `${p.nombre} tiene ${nights.length} noches; el máximo es ${MAX_NIGHTS}.` });
        for (let i = 1; i < nights.length; i++) if (nights[i] === nights[i - 1] + 1) { alerts.push({ level: "bad", type: "nights2", text: `${p.nombre} tiene noches seguidas (${DAYS[nights[i - 1]]} y ${DAYS[nights[i]]}).` }); break; }
      }
    });
    for (let d = 0; d < 7; d++) {
      const cell = schedule.PROD_PM[d].filter((it) => it.role !== "APOYO");
      const hasNuevo = cell.some((it) => { const q = getPerson(it.id); return q && q.puesto === "NUEVO"; });
      const hasAnchor = cell.some((it) => { const q = getPerson(it.id); return q && q.area === "PRODUCTOS" && (q.puesto === "AGENTE" || q.puesto === "SASA"); });
      const nuevoException = cell.some((it) => { const q = getPerson(it.id); return q && q.puesto === "NUEVO" && it.exception; });
      if (hasNuevo && !hasAnchor && !nuevoException) alerts.push({ level: "bad", type: "nightpair", text: `Noche del ${DAYS[d]}: el Nuevo quedó sin Agente ni SASA que lo respalde.` });
    }
    if (PRODHC <= 5) { for (let d = 0; d < 7; d++) if (cajaCount("MBK_PM", d) > 0) alerts.push({ level: "bad", type: "mbk5am", text: `Tienda de ${PRODHC}: MBK no debe tener PM (${DAYS[d]}).` }); }
    const prev = previousWeekApproved();
    if (prev) {
      people.forEach((p) => {
        if (assignmentsOf(p.id).some((a) => a.dayIndex === 0 && a.shiftKey.endsWith("AM")) && (prev.flat?.PROD_PM?.[6] || []).concat(prev.flat?.MBK_PM?.[6] || []).includes(p.nombre)) {
          alerts.push({ level: "bad", type: "restr", text: `${p.nombre} cerró domingo noche la semana pasada y abre lunes AM. Rompe el descanso.` });
        }
      });
    }
    return alerts;
  };
  const penaltyOf = (alerts: Alert[]) => {
    let p = 0;
    alerts.forEach((a) => { p += a.level === "bad" ? (a.type === "over" ? 700 : a.type === "nightpair" ? 1100 : 1000)
      : (a.type === "underprod" ? 220 : a.type === "clustergap" ? 90 : a.type === "cover" ? 60 : a.type === "support" ? 40 : a.type === "apoyo" ? 5 : a.type === "leanhours" ? 2 : a.type === "doblete" ? 8 : 10); });
    return p;
  };

  // Revalidación de una edición manual: no se genera, solo se valida el horario dado.
  if (input.validateOnly) {
    schedule = input.validateOnly;
    const a = computeAlerts();
    return { schedule, alerts: a, penalty: penaltyOf(a) };
  }

  // Multi-intento con presupuesto de tiempo
  const attempts = input.attempts ?? 120;
  const budget = input.timeBudgetMs ?? 8000;
  const t0 = Date.now();
  let best: Schedule | null = null, bestPen = Infinity;
  for (let i = 0; i < attempts; i++) {
    buildOneCandidate();
    const pen = penaltyOf(computeAlerts());
    if (pen < bestPen) { bestPen = pen; best = JSON.parse(JSON.stringify(schedule)); if (pen === 0) break; }
    if (Date.now() - t0 > budget) break;
  }
  schedule = best || buildEmpty();
  return { schedule, alerts: computeAlerts(), penalty: bestPen };
}

/** Revalida un horario editado a mano (reutiliza las mismas reglas que generate).
 * Framework-agnóstico: se puede llamar en el cliente tras un + agregar / × quitar. */
export function validate(input: Omit<GenInput, "validateOnly">, schedule: Schedule): Alert[] {
  return generate({ ...input, validateOnly: schedule }).alerts;
}
