
-- Fix search_path on tg_set_updated_at
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Revoke direct execute on has_role (still usable inside RLS as SECURITY DEFINER)
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;

-- Replace broad SELECT policy with no listing - allow only object access via signed/direct URL
DROP POLICY IF EXISTS "Public can read selfies" ON storage.objects;

-- For a public bucket, files are accessible via their public URL without a SELECT policy.
-- We only need an INSERT/UPDATE/DELETE policy for admins (already created).
-- No SELECT policy = no listing through the API, but public URLs still work.
