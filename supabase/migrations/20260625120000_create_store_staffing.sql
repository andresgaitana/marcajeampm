-- Presupuesto/meta de agentes por tienda (base del Plan de Dotación).
-- prod_agents = personal de productos (caja/retail); mbk_agents = personal MBK.
-- Los valores iniciales se cargaron desde "Data Horario HC" (87 tiendas).
CREATE TABLE IF NOT EXISTS public.store_staffing (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  prod_agents integer NOT NULL DEFAULT 0,
  mbk_agents integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.store_staffing ENABLE ROW LEVEL SECURITY;
