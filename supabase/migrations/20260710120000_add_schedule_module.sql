-- Módulo Creación de Horario (plan semanal por tienda). Aplicada vía MCP; versionada aquí.

-- 1) Atributos del colaborador para el generador de horarios. El área se deriva del rol
--    (cajero→Productos, agente_mbk→MBK); estos campos son la clasificación fina + restricciones.
alter table employees add column if not exists puesto_horario text not null default 'AGENTE'; -- AGENTE|APOYO|NUEVO|PASANTE|SASA
alter table employees add column if not exists estudia text;              -- null|'Sábado'|'Domingo'
alter table employees add column if not exists no_disponible text;        -- 'Viernes, Sábado'
alter table employees add column if not exists horas_meta int not null default 48;
alter table employees add column if not exists apoya_mbk boolean not null default false;

-- 2) Un plan de horario por tienda y semana.
create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  week_start date not null,
  status text not null default 'draft',        -- 'draft' | 'approved'
  coverage jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid,
  unique (store_id, week_start)
);
create index if not exists idx_schedules_store_week on schedules(store_id, week_start);

-- 3) Asignaciones del plan (normalizadas para la adherencia contra el marcaje).
create table if not exists schedule_shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  day_index smallint not null,                 -- 0=Lun .. 6=Dom
  shift_key text not null,                     -- PROD_AM|PROD_PM|MBK_AM|MBK_PM
  role text not null default 'CAJA',           -- CAJA | APOYO
  flags jsonb not null default '{}'::jsonb
);
create index if not exists idx_schedule_shifts_schedule on schedule_shifts(schedule_id);
create index if not exists idx_schedule_shifts_emp on schedule_shifts(employee_id);

-- RLS bloqueado: solo el service_role (server functions con scope) accede.
alter table schedules enable row level security;
alter table schedule_shifts enable row level security;
