-- Horas de entrada por tienda de los 4 turnos de AGENTES (versión final).
--
-- Productos y MBK son áreas distintas que entran a horas distintas (confirmado con el
-- historial: A01 MBK 07:44 vs Prod 06:06), y el turno PM NO se deriva del AM: tiene su
-- propia hora. Por eso son 4 horas independientes por tienda: prod_am, prod_pm, mbk_am,
-- mbk_pm (minutos desde medianoche). Cada turno conserva su duración (Productos 12h,
-- MBK 8h); solo la ENTRADA es configurable. Versionada por fecha (no recalcula el pasado).
-- NO aplica a GT/GZ (regla 8:00 aparte).
--
-- Reemplaza el diseño previo de una sola hora (columna am_entry_min) y su función
-- store_am_entry_min, que quedaron obsoletos. La tabla estaba vacía, sin migración de datos.
create table if not exists store_shift_hours (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  prod_am_entry_min int not null check (prod_am_entry_min between 0 and 1439),
  prod_pm_entry_min int not null check (prod_pm_entry_min between 0 and 1439),
  mbk_am_entry_min  int not null check (mbk_am_entry_min  between 0 and 1439),
  mbk_pm_entry_min  int not null check (mbk_pm_entry_min  between 0 and 1439),
  effective_from date not null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (store_id, effective_from)
);
alter table store_shift_hours enable row level security; -- solo service_role (server fns)

comment on table store_shift_hours is
  'Horas de entrada por tienda de los 4 turnos de agentes: prod_am/prod_pm/mbk_am/mbk_pm (min desde medianoche). Versionada por fecha. La pone el GT una vez; la cambia el GZ. No aplica a GT/GZ.';
