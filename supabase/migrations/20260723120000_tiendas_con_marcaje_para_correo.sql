-- Tiendas "vivas": las que ya tienen agentes marcando.
--
-- El correo de dotación (Edge Function dotacion-report-email) limitaba su alcance con
-- una lista de zonas escrita a mano (pilotZones:["MGA_SUR"]) en el pg_cron. Eso obligaba
-- a acordarse de agregar cada zona nueva: cuando A69 (MGA_CENTRO) empezó a marcar, ni su
-- GT ni su GZ recibían el reporte. Ahora la tienda entra sola el día que arranca.
--
-- Se excluye la zona CAPACITACION: su tienda demo marca durante los entrenamientos y no
-- debe mezclarse con la operación real.
create or replace function public.tiendas_con_marcaje(dias int default 30)
returns table (store_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct a.store_id
  from attendance_records a
  join stores s on s.id = a.store_id and s.active
  left join zones z on z.id = s.zone_id
  where a.created_at >= now() - (dias || ' days')::interval
    and coalesce(z.code, '') <> 'CAPACITACION'
$$;

comment on function public.tiendas_con_marcaje(int) is
  'Tiendas con al menos un marcaje en los ultimos N dias (excluye CAPACITACION). La usa el correo de dotacion para incluir sola a cada tienda que arranca.';

revoke all on function public.tiendas_con_marcaje(int) from public, anon, authenticated;
