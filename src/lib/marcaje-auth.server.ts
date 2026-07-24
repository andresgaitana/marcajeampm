import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Autorización de marcaje por tienda según el rol del colaborador.
 * Fuente única usada por markAttendance, lookupEmployee y beginWebauthnAuth.
 *
 * - Cualquier colaborador puede marcar en su tienda ancla (employees.store_id).
 * - gerente_zona: cualquier tienda de SU ZONA (la zona de su tienda ancla),
 *   derivada en vivo (no depende de datos sembrados estáticos), MÁS los puntos
 *   asignados explícitamente en employee_store_assignments. Esto último cubre dos
 *   casos reales de la operación: el GZ que arranca su semana en una tienda fuera
 *   de su zona (la más cercana a su casa, p. ej. Julio en A59 siendo de Jinotega)
 *   y el marcaje en Oficina los días de reunión. NO se resuelve moviéndole el ancla,
 *   porque el ancla es lo que define QUÉ zona supervisa.
 * - gerente (Gerente de Tienda): además, cualquier tienda listada en
 *   employee_store_assignments (soporte multi-tienda).
 * - cualquier otro rol (cajero / agente_mbk / limpieza / seguridad interna o
 *   tercerizada): SOLO su tienda ancla.
 */
export async function employeeCanMarkAtStore(
  employee: { id: string; role: string; store_id: string },
  store: { id: string; zone_id: string | null },
): Promise<boolean> {
  // Tienda ancla: siempre permitido.
  if (employee.store_id === store.id) return true;

  if (employee.role === "gerente_zona") {
    if (store.zone_id) {
      const { data: anchor } = await supabaseAdmin
        .from("stores")
        .select("zone_id")
        .eq("id", employee.store_id)
        .maybeSingle();
      if (anchor?.zone_id && anchor.zone_id === store.zone_id) return true;
    }
    // Punto asignado a mano (Oficina, o la tienda donde arranca su semana aunque
    // sea de otra zona). Sin esto tendría que marcar solo dentro de su zona.
    const { data: assign } = await supabaseAdmin
      .from("employee_store_assignments")
      .select("id")
      .eq("employee_id", employee.id)
      .eq("store_id", store.id)
      .maybeSingle();
    return !!assign;
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
