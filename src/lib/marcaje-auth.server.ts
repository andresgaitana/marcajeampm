import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Autorización de marcaje por tienda según el rol del colaborador.
 * Fuente única usada por markAttendance, lookupEmployee y beginWebauthnAuth.
 *
 * - Cualquier colaborador puede marcar en su tienda ancla (employees.store_id).
 * - gerente_zona: CUALQUIER tienda activa. Su rutina real lo lleva por toda la
 *   operación (tienda base fuera de su zona por cercanía a su casa, cobertura de
 *   otro GZ de vacaciones, recorrido variable). El resguardo no es la lista de
 *   tiendas sino la GEOCERCA + el ROSTRO: solo marca donde está físicamente, y es
 *   su propia asistencia (no da acceso a datos de la tienda).
 * - gerente (Gerente de Tienda): además de su ancla, cualquier tienda listada en
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

  // El GZ marca en cualquier tienda activa (recorrido, tienda base fuera de zona,
  // cobertura de vacaciones). La geocerca y el rostro son el resguardo.
  if (employee.role === "gerente_zona") return true;

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
