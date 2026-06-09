
-- 1) Extend app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'gerente_tienda';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'gerente_zona';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'gerente_operaciones';

-- Commit enum values before using them
COMMIT;
BEGIN;

-- 2) Zones table
CREATE TABLE IF NOT EXISTS public.zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.zones TO authenticated;
GRANT ALL ON public.zones TO service_role;

ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view zones"
  ON public.zones FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/Ops manage zones"
  ON public.zones FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'gerente_operaciones'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'gerente_operaciones'));

CREATE TRIGGER zones_set_updated_at
  BEFORE UPDATE ON public.zones
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 3) Add zone_id to stores
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS stores_zone_id_idx ON public.stores(zone_id);

-- 4) User-zone assignments (Gerentes de Zona admins)
CREATE TABLE IF NOT EXISTS public.user_zone_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, zone_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_zone_assignments TO authenticated;
GRANT ALL ON public.user_zone_assignments TO service_role;

ALTER TABLE public.user_zone_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin/Ops manage zone assignments"
  ON public.user_zone_assignments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'gerente_operaciones'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'gerente_operaciones'));

CREATE POLICY "Users can view own zone assignments"
  ON public.user_zone_assignments FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 5) Helper functions
CREATE OR REPLACE FUNCTION public.is_zone_user(_user_id uuid, _zone_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_zone_assignments
    WHERE user_id = _user_id AND zone_id = _zone_id
  )
$$;

CREATE OR REPLACE FUNCTION public.accessible_store_ids(_user_id uuid)
RETURNS TABLE(store_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  -- Admin or Operations: all stores
  SELECT s.id FROM public.stores s
  WHERE public.has_role(_user_id, 'admin') OR public.has_role(_user_id, 'gerente_operaciones')
  UNION
  -- Zone manager admin: stores in their zones
  SELECT s.id FROM public.stores s
  JOIN public.user_zone_assignments uza ON uza.zone_id = s.zone_id
  WHERE uza.user_id = _user_id
  UNION
  -- Store manager admin
  SELECT sm.store_id FROM public.store_managers sm
  WHERE sm.user_id = _user_id
$$;

COMMIT;
