/**
 * Forma canónica del código de colaborador: SOLO letras A-Z y dígitos 0-9.
 *
 * Es exactamente la misma normalización que:
 *  - guarda la base en `employees.employee_code_canon` (columna generada, con
 *    índice ÚNICO), y
 *  - se aplica a lo que el colaborador teclea en el terminal de marcaje.
 *
 * Guardar y buscar en esta forma es lo que garantiza una coincidencia única:
 * "A03-01", "a0301" y "A03 01" son el MISMO colaborador, y la base impide que
 * existan dos. Antes se guardaba tal cual se tecleaba y el marcaje comparaba en
 * mayúsculas, así que un código creado como "Pr01" nunca se encontraba.
 */
export function normalizeEmployeeCode(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Mensaje único para cuando el código no queda en un valor utilizable. */
export const CODE_HELP = "El código solo puede llevar letras y números (sin espacios ni guiones).";
