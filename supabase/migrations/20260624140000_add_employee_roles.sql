-- Nuevos roles de colaborador para marcaje:
--   personal_limpieza      → Personal de Limpieza
--   seguridad_interna      → Seguridad Interna
--   seguridad_tercerizada  → Seguridad Tercerizada
-- En el Horario caen en el área "Productos" (todo lo que no es Agente MBK).
-- El rol antiguo 'seguridad' se conserva (compatibilidad); en la UI ya no se ofrece.
ALTER TYPE public.employee_role ADD VALUE IF NOT EXISTS 'personal_limpieza';
ALTER TYPE public.employee_role ADD VALUE IF NOT EXISTS 'seguridad_interna';
ALTER TYPE public.employee_role ADD VALUE IF NOT EXISTS 'seguridad_tercerizada';
