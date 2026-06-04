ALTER TYPE public.employee_role ADD VALUE IF NOT EXISTS 'agente_mbk';
ALTER TYPE public.employee_role ADD VALUE IF NOT EXISTS 'gerente_zona';

CREATE TABLE IF NOT EXISTS public.employee_store_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, store_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_store_assignments TO authenticated;
GRANT ALL ON public.employee_store_assignments TO service_role;

ALTER TABLE public.employee_store_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage employee_store_assignments"
  ON public.employee_store_assignments
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Managers view their store assignments"
  ON public.employee_store_assignments
  FOR SELECT TO authenticated
  USING (public.is_store_manager(auth.uid(), store_id));

CREATE INDEX IF NOT EXISTS idx_esa_employee ON public.employee_store_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_esa_store ON public.employee_store_assignments(store_id);