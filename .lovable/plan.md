
## Resumen
Convertir el MVP en un sistema multi-tienda escalable (87+ tiendas), con login propio para cada gerente, terminales de marcaje fijadas a una tienda, y un dashboard con métricas. Además, hacer mucho más visual la diferencia entre **Entrada** y **Salida**.

## 1. Base de datos (nueva migración)

**Nueva tabla `stores`** — catálogo central de tiendas
- `code` (único, ej. "T001"), `name`, `address`, `terminal_pin` (PIN para fijar terminal), `active`

**Nueva tabla `store_managers`** — qué usuarios gestionan qué tiendas
- `user_id`, `store_id` (un gerente puede tener varias tiendas; útil para regionales)

**Cambios en tablas existentes**
- `employees`: agregar `store_id` (FK obligatorio a `stores`) — los empleados pertenecen a una tienda
- `attendance_records`: agregar `store_id` (se llena al marcar; permite filtros rápidos)
- Nuevo rol `gerente_tienda` en `app_role` (admin sigue siendo global)

**Funciones helper (security definer)**
- `is_store_manager(user_id, store_id) → boolean` — usada en RLS para evitar recursión
- Políticas RLS: admin ve todo; gerente ve solo sus tiendas (empleados y marcajes filtrados por `store_id`)

## 2. Pantalla de marcaje (terminal) — `/`

**Setup inicial de terminal** (una sola vez por dispositivo)
- Al abrir por primera vez: pedir **código de tienda + PIN de terminal**
- Se valida contra `stores` y se guarda `store_id` en `localStorage`
- Header muestra siempre: "Tienda T001 — Sucursal Centro" + botón "Cambiar tienda"

**Flujo de marcaje**
- Solo permite marcar a empleados de la tienda fijada (validación servidor)
- **Botones Entrada/Salida mucho más claros:**
  - Entrada: verde grande con ícono ↓ "ENTRADA"
  - Salida: naranja/rojo grande con ícono ↑ "SALIDA"
  - Después de seleccionar, una franja de color en TODAS las pantallas siguientes (PIN, selfie) recuerda "Vas a marcar **ENTRADA**" con el color correspondiente
  - Confirmación final ocupa toda la pantalla con el tipo en grande

## 3. Panel admin — `/admin`

**Nueva pestaña: Dashboard** (vista por defecto)
- **Hoy en tiempo real:** entradas/salidas del día, colaboradores actualmente "dentro" (con entrada sin salida)
- **Semanal/mensual por colaborador:** tabla con días trabajados, horas totales, retardos
- **Comparativa entre tiendas** (solo admin global): ranking por puntualidad y asistencia
- **Alertas:** colaboradores sin marcar salida (>10h dentro), retardos, sin marcar hoy

**Nueva pestaña: Tiendas** (solo admin global)
- CRUD de tiendas + generador de PIN de terminal
- Asignar gerentes a tiendas

**Pestañas existentes actualizadas**
- **Colaboradores:** agregar selector de tienda obligatorio; gerente solo ve los suyos
- **Marcajes:** filtro por tienda y rango de fechas; gerente solo ve los suyos

## 4. Autenticación y roles

- Admin: rol existente (ve todo)
- Gerente de tienda: registrado por admin en pestaña "Tiendas"; al hacer login solo ve sus tiendas
- Login sigue siendo email + contraseña en `/admin/login`

## Detalles técnicos
- Server functions: `listStores`, `createStore`, `assignManager`, `setTerminalStore` (valida PIN), `getDashboardMetrics(storeId?, range)`, `getOpenSessions(storeId?)`
- Cliente: `useTerminalStore()` hook que lee `localStorage.terminal_store_id`
- RLS: `attendance_records` y `employees` con políticas combinando `has_role('admin')` OR `is_store_manager(auth.uid(), store_id)`
- Migración de datos existentes: crear tienda "Default" y asignar empleados/marcajes huérfanos a ella

## Lo que NO incluye este plan
- App móvil nativa (sigue siendo web)
- Integración con huellero físico
- Exportación PDF (sigue siendo CSV)
- Geolocalización del marcaje

¿Procedo con la implementación?
