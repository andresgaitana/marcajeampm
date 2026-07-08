-- Cobertura entre tiendas y polivalencia (Caso 1 y Caso 2 sugeridos por los GT).
--   attendance_records.area       → área del turno (productos | mbk) cuando un
--                                    polivalente o cobertura escoge dónde trabaja.
--   attendance_records.cobertura  → true si el colaborador marcó en una tienda que
--                                    no es la suya (apoyo/préstamo).
--   employees.polivalente         → cajero que también cubre en la otra área; al
--                                    marcar ENTRADA se le pregunta el área.
-- Aplicada originalmente vía MCP; se versiona aquí (idempotente) para el repo.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS cobertura boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS polivalente boolean NOT NULL DEFAULT false;
