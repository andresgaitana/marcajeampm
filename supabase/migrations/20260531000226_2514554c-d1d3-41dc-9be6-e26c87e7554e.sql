
CREATE TABLE IF NOT EXISTS public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text,
  terminal_pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.store_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, store_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_managers TO authenticated;
GRANT ALL ON public.store_managers TO service_role;
ALTER TABLE public.store_managers ENABLE ROW LEVEL SECURITY;

INSERT INTO public.stores (code, name, terminal_pin_hash, active)
VALUES ('DEFAULT', 'Tienda Default', 'placeholder:placeholder', true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id) ON DELETE RESTRICT;

UPDATE public.employees
SET store_id = (SELECT id FROM public.stores WHERE code = 'DEFAULT')
WHERE store_id IS NULL;

ALTER TABLE public.employees ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_store ON public.employees(store_id);

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id) ON DELETE RESTRICT;

UPDATE public.attendance_records ar
SET store_id = e.store_id
FROM public.employees e
WHERE ar.employee_id = e.id AND ar.store_id IS NULL;

ALTER TABLE public.attendance_records ALTER COLUMN store_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_store_created ON public.attendance_records(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_created ON public.attendance_records(employee_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.is_store_manager(_user_id uuid, _store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_managers
    WHERE user_id = _user_id AND store_id = _store_id
  )
$$;

DROP TRIGGER IF EXISTS tg_stores_updated_at ON public.stores;
CREATE TRIGGER tg_stores_updated_at
  BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP POLICY IF EXISTS "Admins manage stores" ON public.stores;
CREATE POLICY "Admins manage stores" ON public.stores FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin')) WITH CHECK (has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Managers view their stores" ON public.stores;
CREATE POLICY "Managers view their stores" ON public.stores FOR SELECT TO authenticated
  USING (is_store_manager(auth.uid(), id));

DROP POLICY IF EXISTS "Admins manage store_managers" ON public.store_managers;
CREATE POLICY "Admins manage store_managers" ON public.store_managers FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin')) WITH CHECK (has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Users view their own assignments" ON public.store_managers;
CREATE POLICY "Users view their own assignments" ON public.store_managers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Managers view their store employees" ON public.employees;
CREATE POLICY "Managers view their store employees" ON public.employees FOR SELECT TO authenticated
  USING (is_store_manager(auth.uid(), store_id));

DROP POLICY IF EXISTS "Managers view their store attendance" ON public.attendance_records;
CREATE POLICY "Managers view their store attendance" ON public.attendance_records FOR SELECT TO authenticated
  USING (is_store_manager(auth.uid(), store_id));
