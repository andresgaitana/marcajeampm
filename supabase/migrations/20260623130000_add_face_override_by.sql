-- Override de supervisor: cuando el reconocimiento facial falla, un Gerente de
-- Tienda o de Zona con autoridad sobre la tienda puede autorizar el marcaje con
-- su PIN. Se registra quién autorizó (auditoría).
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS face_override_by uuid REFERENCES public.employees(id);
