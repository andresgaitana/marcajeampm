-- 1) Stores: geolocation
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS geofence_radius_m integer NOT NULL DEFAULT 300;

-- 2) Employees: username / password (alternative to PIN)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS password_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS employees_username_unique
  ON public.employees (lower(username))
  WHERE username IS NOT NULL;

-- 3) Attendance: location + auth method
DO $$ BEGIN
  CREATE TYPE public.auth_method AS ENUM ('pin','password','webauthn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS location_accuracy_m double precision,
  ADD COLUMN IF NOT EXISTS location_valid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auth_method public.auth_method NOT NULL DEFAULT 'pin';

-- 4) WebAuthn credentials per employee/device
CREATE TABLE IF NOT EXISTS public.employee_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS employee_credentials_employee_idx
  ON public.employee_credentials(employee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_credentials TO authenticated;
GRANT ALL ON public.employee_credentials TO service_role;

ALTER TABLE public.employee_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage employee_credentials"
  ON public.employee_credentials FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Managers view their store credentials"
  ON public.employee_credentials FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = employee_credentials.employee_id
      AND is_store_manager(auth.uid(), e.store_id)
  ));

-- 5) Temporary challenges for WebAuthn ceremonies
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register','auth')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_challenge_idx
  ON public.webauthn_challenges(challenge);

GRANT ALL ON public.webauthn_challenges TO service_role;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated: only service_role (server functions) touches this table.
