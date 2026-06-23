import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Autorización de marcaje por tienda según el rol del colaborador.
 * Fuente única usada por markAttendance, lookupEmployee y beginWebauthnAuth.
 *
 * - Cualquier colaborador puede marcar en su tienda ancla (employees.store_id).
 * - gerente_zona: cualquier tienda de SU ZONA (la zona de su tienda ancla),
 *   derivada en vivo (no depende de datos sembrados estáticos).
 * - gerente (Gerente de Tienda): además, cualquier tienda listada en
 *   employee_store_assignments (soporte multi-tienda).
 * - cajero / agente_mbk / seguridad: SOLO su tienda ancla.
 */
export async function employeeCanMarkAtStore(
  employee: { id: string; role: string; store_id: string },
  store: { id: string; zone_id: string | null },
): Promise<boolean> {
  // Tienda ancla: siempre permitido.
  if (employee.store_id === store.id) return true;

  if (employee.role === "gerente_zona") {
    if (!store.zone_id) return false;
    const { data: anchor } = await supabaseAdmin
      .from("stores")
      .select("zone_id")
      .eq("id", employee.store_id)
      .maybeSingle();
    return !!anchor?.zone_id && anchor.zone_id === store.zone_id;
  }

  if (employee.role === "gerente") {
    const { data: assign } = await supabaseAdmin
      .from("employee_store_assignments")
      .select("id")
      .eq("employee_id", employee.id)
      .eq("store_id", store.id)
      .maybeSingle();
    return !!assign;
  }

  return false;
}
