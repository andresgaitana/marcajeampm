-- Código de colaborador: coincidencia única + baja lógica.
--
-- Problema que resuelve (reportado por el GT en el piloto, 22/07/2026):
--  1. El GT creaba "Pr01" y el marcaje no lo encontraba, porque el terminal
--     convierte a mayúsculas lo que teclea el colaborador y luego comparaba por
--     coincidencia EXACTA contra lo guardado. 3 colaboradores de A69 quedaron sin
--     poder marcar.
--  2. El unique de employee_code era sensible a mayúsculas: "PR01" y "Pr01"
--     podían coexistir siendo el mismo código para el marcaje.
--  3. Borrar a quien dejó de laborar arrastraba en cascada TODOS sus marcajes
--     (todas las FK hacia employees son ON DELETE CASCADE).

-- 1) Canonizar a mayúsculas los códigos que quedaron fuera del estándar.
update employees
   set employee_code = upper(employee_code)
 where employee_code <> upper(employee_code);

-- 2) Forma canónica del código: solo A-Z y 0-9. Es exactamente la misma
--    normalización que la app aplica a lo que teclea el colaborador
--    (src/lib/employee-code.ts), así que guardarla permite una coincidencia
--    única y exacta sin importar mayúsculas, guiones o espacios.
--    Es una columna generada: no hay que mantenerla.
alter table employees
  add column if not exists employee_code_canon text
  generated always as (regexp_replace(upper(employee_code), '[^A-Z0-9]', '', 'g')) stored;

-- 3) Garantía a nivel de base: dos colaboradores NO pueden compartir código, ni
--    siquiera escrito distinto ("A0301", "a03-01" y "A03 01" son el mismo).
--    El código debe ser único en TODA la empresa porque el marcaje lo busca sin
--    filtrar por tienda (un colaborador puede marcar en otra tienda cuando da
--    cobertura).
create unique index if not exists employees_code_canon_key
  on employees (employee_code_canon);

-- 4) Baja lógica auditada: en vez de borrar, se desactiva dejando constancia de
--    cuándo dejó de laborar y quién lo registró. El historial se conserva.
alter table employees
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid;

comment on column employees.employee_code_canon is
  'Forma canonica (A-Z0-9) del codigo. Unica en toda la empresa. Es la columna por la que busca el marcaje.';
comment on column employees.deactivated_at is
  'Fecha de baja del colaborador. NULL = activo. Se conserva todo su historial de marcajes.';
