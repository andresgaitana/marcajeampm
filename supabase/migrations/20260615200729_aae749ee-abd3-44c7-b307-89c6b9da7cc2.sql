ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS failed_selfie_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selfie_blocked_until timestamptz;