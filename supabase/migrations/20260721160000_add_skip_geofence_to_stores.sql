-- Flag por tienda para OMITIR la validación de geocerca en el marcaje.
-- Uso: tiendas demo / de capacitación que no tienen una ubicación física fija
-- (la capacitación puede ser en distintos lugares). Las tiendas reales quedan en
-- false (comportamiento normal: geocerca obligatoria).
alter table public.stores
  add column if not exists skip_geofence boolean not null default false;

comment on column public.stores.skip_geofence is
  'Si true, el marcaje NO valida geocerca (para tiendas demo/capacitación sin ubicación fija).';
