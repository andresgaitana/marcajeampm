-- Hora de entrada del turno AM por TIENDA, para los AGENTES (cajero/agente_mbk).
--
-- Problema: el estándar 6:00 está hardcodeado y algunas tiendas de acceso difícil
-- entran más tarde (agentes de comunidades, poco transporte). El "marcaron tarde"
-- salía en 35–64% en todas las tiendas, mezclando tardanza real con horario distinto.
-- Confirmado en producción: A01 pasa de 57% "tarde" (vs 6:00) a 35% (vs su 7:30 real).
--
-- Una sola hora por tienda: el AM de Productos y de MBK arranca ahí; el PM se deriva
-- (+12h Prod, +8h MBK). VERSIONADO por fecha para NO recalcular meses cerrados: para
-- evaluar un marcaje del día D se usa la versión vigente en D. NO aplica a GT/GZ
-- (tienen su propia regla de 8:00) — "3 relojes que no se cruzan".
create table if not exists store_shift_hours (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  am_entry_min int not null check (am_entry_min between 240 and 720), -- minutos desde medianoche (4:00–12:00)
  effective_from date not null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (store_id, effective_from)
);
alter table store_shift_hours enable row level security; -- solo service_role (server fns)

comment on table store_shift_hours is
  'Hora de entrada del turno AM por tienda para agentes, versionada por fecha. 360=6:00. La pone el GT una vez; la cambia el GZ. No aplica a GT/GZ.';

-- Hora AM vigente para una tienda en una fecha (default 6:00 = 360 si nunca se configuró).
create or replace function public.store_am_entry_min(_store_id uuid, _on date)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(
    (select am_entry_min from store_shift_hours
      where store_id = _store_id and effective_from <= _on
      order by effective_from desc limit 1),
    360)
$$;

revoke all on function public.store_am_entry_min(uuid, date) from public, anon, authenticated;
