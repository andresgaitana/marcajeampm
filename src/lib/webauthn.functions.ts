import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
} from "@simplewebauthn/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function rpInfo() {
  const req = getRequest();
  const url = new URL(req.url);
  return { rpID: url.hostname, origin: url.origin, rpName: "Marcaje" };
}

/**
 * Allow fingerprint registration for: Admin, Gerente de Operaciones,
 * or a Gerente de Zona / Gerente de Tienda whose accessible stores include
 * the employee's store. This lets each GT take responsibility for
 * enrolling fingerprints of their own team.
 */
async function assertCanManageEmployeeCreds(userId: string, employeeId: string) {
  const { data: roleRows } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId);
  const roles = (roleRows ?? []).map((r) => r.role as string);
  if (roles.includes("admin") || roles.includes("gerente_operaciones")) return;

  const { data: emp } = await supabaseAdmin
    .from("employees").select("store_id").eq("id", employeeId).maybeSingle();
  if (!emp) throw new Error("Colaborador no encontrado");

  const { data: accessible } = await supabaseAdmin
    .rpc("accessible_store_ids", { _user_id: userId });
  const storeIds = (accessible ?? []).map((r: { store_id: string }) => r.store_id);
  if (!storeIds.includes(emp.store_id))
    throw new Error("Acceso denegado: este colaborador no pertenece a tus tiendas");
}

/** Admin: begin registration ceremony for an employee on this device. */
export const beginWebauthnRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ employeeId: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    await assertCanManageEmployeeCreds(context.userId, data.employeeId);
    const { data: emp } = await supabaseAdmin
      .from("employees").select("id, employee_code, full_name").eq("id", data.employeeId).maybeSingle();
    if (!emp) throw new Error("Colaborador no encontrado");

    const { data: existing } = await supabaseAdmin
      .from("employee_credentials").select("credential_id, transports").eq("employee_id", emp.id);

    const { rpID, rpName } = rpInfo();
    const opts = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: emp.employee_code,
      userDisplayName: emp.full_name,
      userID: new TextEncoder().encode(emp.id),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "discouraged",
        userVerification: "preferred",
      },
      excludeCredentials: (existing ?? []).map((c) => ({
        id: c.credential_id,
        transports: c.transports ? (c.transports.split(",") as AuthenticatorTransport[]) : undefined,
      })),
    });

    await supabaseAdmin.from("webauthn_challenges").insert({
      employee_id: emp.id,
      challenge: opts.challenge,
      purpose: "register",
    });

    return opts;
  });

/** Admin: finish registration; stores the credential. */
export const finishWebauthnRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      employeeId: z.string().uuid(),
      // attestation response from @simplewebauthn/browser startRegistration()
      response: z.any(),
      deviceLabel: z.string().trim().max(80).optional(),
    }).parse(i),
  )
  .handler(async ({ context, data }) => {
    await assertCanManageEmployeeCreds(context.userId, data.employeeId);
    const { data: ch } = await supabaseAdmin
      .from("webauthn_challenges")
      .select("id, challenge, expires_at")
      .eq("employee_id", data.employeeId)
      .eq("purpose", "register")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ch) return { ok: false as const, error: "Sin reto activo. Vuelve a iniciar." };
    if (new Date(ch.expires_at).getTime() < Date.now())
      return { ok: false as const, error: "El reto expiró. Reintenta." };

    const { rpID, origin } = rpInfo();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: data.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Verificación falló" };
    }
    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false as const, error: "No se pudo verificar la huella" };
    }
    const info = verification.registrationInfo;
    const credential = info.credential;
    const pkBase64 = Buffer.from(credential.publicKey).toString("base64");

    const { error } = await supabaseAdmin.from("employee_credentials").insert({
      employee_id: data.employeeId,
      credential_id: credential.id,
      public_key: pkBase64,
      counter: credential.counter ?? 0,
      transports: credential.transports?.join(",") ?? null,
      device_label: data.deviceLabel ?? null,
    });
    if (error) return { ok: false as const, error: error.message };

    await supabaseAdmin.from("webauthn_challenges").delete().eq("id", ch.id);
    return { ok: true as const };
  });

/** Public: begin authentication ceremony for an employee at a terminal. */
export const beginWebauthnAuth = createServerFn({ method: "POST" })
  .inputValidator((i) =>
    z.object({
      employeeCode: z.string().trim().min(1).max(32),
      storeCode: z.string().trim().min(1).max(32),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    const { data: store } = await supabaseAdmin
      .from("stores").select("id").eq("code", data.storeCode).maybeSingle();
    if (!store) return { ok: false as const, error: "Tienda no encontrada" };
    const { data: emp } = await supabaseAdmin
      .from("employees").select("id, store_id, active").eq("employee_code", data.employeeCode).maybeSingle();
    if (!emp || !emp.active) return { ok: false as const, error: "Colaborador no válido" };
    if (emp.store_id !== store.id) return { ok: false as const, error: "Colaborador no pertenece a esta tienda" };

    const { data: creds } = await supabaseAdmin
      .from("employee_credentials").select("credential_id, transports").eq("employee_id", emp.id);
    if (!creds || creds.length === 0)
      return { ok: false as const, error: "Este colaborador no tiene huella registrada" };

    const { rpID } = rpInfo();
    const opts = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      allowCredentials: creds.map((c) => ({
        id: c.credential_id,
        transports: c.transports ? (c.transports.split(",") as AuthenticatorTransport[]) : undefined,
      })),
    });

    await supabaseAdmin.from("webauthn_challenges").insert({
      employee_id: emp.id,
      challenge: opts.challenge,
      purpose: "auth",
    });

    return { ok: true as const, options: opts };
  });

/** List registered credentials for an employee (admin/manager). */
export const listEmployeeCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ employeeId: z.string().uuid() }).parse(i))
  .handler(async ({ data }) => {
    const { data: rows } = await supabaseAdmin
      .from("employee_credentials")
      .select("id, device_label, created_at, last_used_at")
      .eq("employee_id", data.employeeId)
      .order("created_at", { ascending: false });
    return rows ?? [];
  });

export const deleteEmployeeCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const { data: cred } = await supabaseAdmin
      .from("employee_credentials").select("employee_id").eq("id", data.id).maybeSingle();
    if (!cred) throw new Error("Credencial no encontrada");
    await assertCanManageEmployeeCreds(context.userId, cred.employee_id);
    const { error } = await supabaseAdmin.from("employee_credentials").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });