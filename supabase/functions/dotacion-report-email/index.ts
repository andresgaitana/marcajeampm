// Supabase Edge Function (Deno): envía por correo la "Dotación real por tienda"
// del corte (AM/PM) a GT (su tienda), GZ (su zona) y GO/Admin (todas), por SMTP.
//
// Body opcional: { corte:"AM"|"PM", pilotZones:["MGA_SUR"], dryRun:true, testTo:"x@y",
//   secret:"..." }. Sin corte, se infiere por hora NI. pilotZones limita a esas zonas.
// dryRun devuelve la lista de destinatarios sin enviar. testTo envía solo a esa dirección.
//
// Secretos: SMTP_HOST, SMTP_PORT, SMTP_SECURE ("true" p/465), SMTP_USER, SMTP_PASS,
//   SMTP_FROM, CRON_SECRET (opcional). Disparada 2x/día por pg_cron.
//
// NOTA: se abre una conexión SMTP NUEVA por correo (+pausa) porque el SMTP de iPage
// (hosting compartido) cierra/limita al enviar varios sobre una sola conexión (daba 503).

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const NI_OFFSET_MS = 6 * 3600 * 1000;

function dotacionPlan(prod: number, mbk: number, dow: number) {
  let prodAm = 0, prodPm = 0;
  if (prod >= 7) { prodAm = 2; prodPm = 2; }
  else if (prod === 6) { prodAm = [0, 1, 5, 6].includes(dow) ? 2 : 1; prodPm = 2; }
  else if (prod === 5) { prodAm = 1; prodPm = 2; }
  let mbkAm = 0, mbkPm = 0;
  if (mbk >= 4) { mbkAm = dow === 3 ? 1 : 2; mbkPm = 2; }
  else if (mbk === 3) { mbkAm = 1; mbkPm = 2; }
  else if (mbk === 2) { mbkAm = 1; mbkPm = 1; }
  else if (mbk === 1) { mbkAm = 1; mbkPm = 0; }
  return { prodAm, prodPm, mbkAm, mbkPm };
}

// deno-lint-ignore no-explicit-any
function buildHtml(rows: any[], corte: string, dateLabel: string) {
  const fmt = (real: number, plan: number) => {
    const color = plan === 0 ? "#888" : real >= plan ? "#137A4B" : "#B45309";
    return `<span style="color:${color};font-weight:600">${real}/${plan}</span>`;
  };
  const trs = rows.map((r) => {
    const ready = r.prodReal >= r.prodPlan && r.mbkReal >= r.mbkPlan;
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${r.code}</b> ${r.name}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(r.prodReal, r.prodPlan)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(r.mbkReal, r.mbkPlan)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;color:${ready ? "#137A4B" : "#B45309"};font-weight:600">${ready ? "Listo" : "Falta"}</td></tr>`;
  }).join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#20303B">` +
    `<h2 style="color:#E8622A;margin:0 0 4px">Dotación real por tienda — Turno ${corte}</h2>` +
    `<p style="color:#5B6B78;margin:0 0 12px">${dateLabel} · Agentes presentes (Productos y MBK) vs plan del corte.</p>` +
    `<table style="border-collapse:collapse;width:100%;max-width:640px;font-size:14px"><thead><tr style="background:#F4F6F8">` +
    `<th style="padding:6px 10px;text-align:left">Tienda</th><th style="padding:6px 10px;text-align:right">Productos</th>` +
    `<th style="padding:6px 10px;text-align:right">MBK</th><th style="padding:6px 10px;text-align:center">Estado</th>` +
    `</tr></thead><tbody>${trs}</tbody></table>` +
    `<p style="color:#888;font-size:12px;margin-top:12px">Verde = cubierto · Ámbar = falta. "Listo" solo si Productos y MBK están cubiertos.</p></div>`;
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (cronSecret && body?.secret !== cronSecret) return Response.json({ ok: false, error: "no autorizado" }, { status: 401 });

    const nowNI = new Date(Date.now() - NI_OFFSET_MS);
    const hourNow = nowNI.getUTCHours();
    const corte = (body?.corte === "AM" || body?.corte === "PM") ? body.corte : (hourNow >= 5 && hourNow < 14 ? "AM" : "PM");

    const host = Deno.env.get("SMTP_HOST");
    const port = Number(Deno.env.get("SMTP_PORT") ?? "587");
    const user = Deno.env.get("SMTP_USER");
    const pass = Deno.env.get("SMTP_PASS");
    const from = Deno.env.get("SMTP_FROM") ?? user ?? "";
    const secure = (Deno.env.get("SMTP_SECURE") ?? (port === 465 ? "true" : "false")) === "true";

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const todayStr = nowNI.toISOString().slice(0, 10);
    const startTodayISO = new Date(new Date(todayStr + "T00:00:00Z").getTime() + NI_OFFSET_MS).toISOString();
    const dow = new Date(todayStr + "T00:00:00Z").getUTCDay();
    const dateLabel = `${String(nowNI.getUTCDate()).padStart(2, "0")}/${String(nowNI.getUTCMonth() + 1).padStart(2, "0")}/${nowNI.getUTCFullYear()}`;

    const parts = await Promise.all([
      supabase.from("stores").select("id, code, name, zone_id").eq("active", true),
      supabase.from("store_staffing").select("store_id, prod_agents, mbk_agents"),
      supabase.from("employees").select("id, role").eq("active", true).in("role", ["cajero", "agente_mbk"]),
      supabase.from("attendance_records").select("created_at, employee_id, store_id").eq("type", "entrada").gte("created_at", startTodayISO),
      supabase.from("user_roles").select("user_id, role"),
      supabase.from("user_zone_assignments").select("user_id, zone_id"),
      supabase.from("store_managers").select("user_id, store_id"),
      supabase.from("zones").select("id, code"),
    ]);
    const [stores, staffing, emps, recs, uroles, uzones, smgrs, zonesData] = parts.map((r) => r.data ?? []) as any[];

    let pilotStoreIdSet: Set<string> | null = null;
    if (Array.isArray(body?.pilotZones) && body.pilotZones.length) {
      const pilotZoneIds = new Set(zonesData.filter((z: any) => body.pilotZones.includes(z.code)).map((z: any) => z.id));
      pilotStoreIdSet = new Set(stores.filter((s: any) => s.zone_id && pilotZoneIds.has(s.zone_id)).map((s: any) => s.id));
    }

    const staffMap = new Map(staffing.map((x: any) => [x.store_id, x]));
    const roleById = new Map(emps.map((e: any) => [e.id, e.role]));
    const bandProdAM = (h: number) => h >= 5 && h < 17;
    const bandMbkAM = (h: number) => h >= 5 && h < 13;
    const prodSet = new Map<string, Set<string>>();
    const mbkSet = new Map<string, Set<string>>();
    for (const r of recs) {
      const role = roleById.get(r.employee_id);
      if (!role) continue;
      const h = new Date(new Date(r.created_at).getTime() - NI_OFFSET_MS).getUTCHours();
      if (role === "cajero") {
        if ((corte === "AM") !== bandProdAM(h)) continue;
        if (!prodSet.has(r.store_id)) prodSet.set(r.store_id, new Set());
        prodSet.get(r.store_id)!.add(r.employee_id);
      } else {
        if ((corte === "AM") !== bandMbkAM(h)) continue;
        if (!mbkSet.has(r.store_id)) mbkSet.set(r.store_id, new Set());
        mbkSet.get(r.store_id)!.add(r.employee_id);
      }
    }

    const rowByStore = new Map<string, any>();
    const zoneStores = new Map<string, string[]>();
    for (const s of stores) {
      const st: any = staffMap.get(s.id);
      const pl = dotacionPlan(st?.prod_agents ?? 0, st?.mbk_agents ?? 0, dow);
      rowByStore.set(s.id, { code: s.code, name: s.name, prodReal: prodSet.get(s.id)?.size ?? 0, prodPlan: corte === "AM" ? pl.prodAm : pl.prodPm, mbkReal: mbkSet.get(s.id)?.size ?? 0, mbkPlan: corte === "AM" ? pl.mbkAm : pl.mbkPm });
      if (s.zone_id) { if (!zoneStores.has(s.zone_id)) zoneStores.set(s.zone_id, []); zoneStores.get(s.zone_id)!.push(s.id); }
    }
    const allStoreIds = stores.map((s: any) => s.id);

    const emailById = new Map<string, string>();
    for (let page = 1; page <= 20; page++) {
      const { data } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      const users = data?.users ?? [];
      for (const u of users) if (u.email) emailById.set(u.id, u.email);
      if (users.length < 1000) break;
    }

    const recipients = new Map<string, Set<string>>();
    const add = (uid: string, ids: string[]) => {
      if (!emailById.has(uid)) return;
      const fids = pilotStoreIdSet ? ids.filter((id) => pilotStoreIdSet!.has(id)) : ids;
      if (fids.length === 0) return;
      if (!recipients.has(uid)) recipients.set(uid, new Set());
      const set = recipients.get(uid)!;
      for (const id of fids) set.add(id);
    };
    for (const r of uroles) if (r.role === "admin" || r.role === "gerente_operaciones") add(r.user_id, allStoreIds);
    for (const z of uzones) add(z.user_id, zoneStores.get(z.zone_id) ?? []);
    for (const m of smgrs) add(m.user_id, [m.store_id]);

    if (body?.testTo) { recipients.clear(); emailById.set("__test__", body.testTo); recipients.set("__test__", new Set(pilotStoreIdSet ? [...pilotStoreIdSet] : allStoreIds)); }

    if (body?.dryRun) {
      const list = [...recipients].map(([uid, ids]) => ({ email: emailById.get(uid), tiendas: ids.size }));
      return Response.json({ ok: true, dryRun: true, corte, recipients: recipients.size, list });
    }

    if (!host || !user || !pass) return Response.json({ ok: false, error: "SMTP no configurado (faltan SMTP_HOST/USER/PASS)" });

    let sent = 0, failed = 0;
    const errors: string[] = [];
    for (const [uid, storeIds] of recipients) {
      const email = emailById.get(uid)!;
      const rows = [...storeIds].map((id) => rowByStore.get(id)).filter(Boolean);
      if (rows.length === 0) continue;
      rows.sort((a, b) => (a.code < b.code ? -1 : 1));
      const html = buildHtml(rows, corte, dateLabel);
      const client = new SMTPClient({ connection: { hostname: host, port, tls: secure, auth: { username: user, password: pass } } });
      try {
        await client.send({ from, to: email, subject: `Dotación por tienda — Turno ${corte} — ${dateLabel}`, html, content: "Reporte de dotación (ver versión HTML)." });
        sent++;
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(`${email}: ${String(e)}`);
        console.error("send fail", email, String(e));
      }
      try { await client.close(); } catch (_e) { /* ignore */ }
      await new Promise((res) => setTimeout(res, 400));
    }
    return Response.json({ ok: true, corte, date: dateLabel, recipients: recipients.size, sent, failed, errors });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
