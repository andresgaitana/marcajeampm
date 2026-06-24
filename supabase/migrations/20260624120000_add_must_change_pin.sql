-- PIN temporal: cuando un supervisor (GT/GZ/Super admin) restablece el PIN de
-- un colaborador, este queda en 1234 y debe definir un PIN propio en su primer
-- marcaje. Este flag fuerza ese cambio una sola vez.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS must_change_pin boolean NOT NULL DEFAULT false;
