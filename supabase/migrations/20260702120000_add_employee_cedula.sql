-- Cédula de identidad del colaborador (para agentes y gerentes de tienda).
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS cedula text;
COMMENT ON COLUMN public.employees.cedula IS 'Cédula de identidad del colaborador (agentes y gerentes de tienda).';
