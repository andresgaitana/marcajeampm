-- Reconocimiento facial: descriptor de referencia por colaborador (128 floats,
-- calculado en cliente con face-api). Se compara contra la selfie en cada marcaje.
-- face_enrolled_at marca si el colaborador ya tiene enrolamiento (NULL = legacy,
-- marca sin comparación facial hasta que se le tome la foto de referencia).
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS face_descriptor real[];
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS face_enrolled_at timestamptz;
