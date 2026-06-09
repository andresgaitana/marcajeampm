## Resumen
Agregar tres niveles administrativos (Gerente de Tienda, Gerente de Zona, Gerente de Operaciones), introducir el concepto de Zona con tiendas asignadas, y mejorar el Dashboard para ver el comportamiento del horario por persona.

## 1. Base de datos (migración)

- **Nueva tabla `zones`**: `code`, `name`, `active`.
- **`stores.zone_id`**: columna nueva (nullable) con FK a `zones`.
- **Enum `app_role`** ampliado: agregar `gerente_tienda`, `gerente_zona`, `gerente_operaciones` (se mantiene `admin` como super-admin).
- **Nueva tabla `user_zone_assignments`** (`user_id`, `zone_id`) para vincular Gerentes de Zona a una o más zonas.
- Funciones SECURITY DEFINER: `is_operations(uid)`, `accessible_store_ids(uid)` que devuelve el conjunto de tiendas visibles según rol (admin/operaciones = todas; gerente_zona = tiendas de sus zonas; gerente_tienda = tiendas de `store_managers`).
- RLS + GRANTs estándar para las nuevas tablas.

## 2. Backend (server functions)

- `admin.functions.ts`:
  - Reescribir `getScope()` para usar `accessible_store_ids` y reconocer los nuevos roles.
  - `checkAdmin` devuelve `{ isAdmin, isOperations, isZoneManager, isStoreManager, storeIds }`.
  - CRUD de zonas (`listZones`, `createZone`, `updateZone`, `deleteZone`) — solo admin/operaciones.
  - Asignación de usuarios a zonas (`listZoneManagers`, `addZoneManager`, `removeZoneManager`) similar a `store_managers`.
- `stores.functions.ts`: `createStore`/`updateStore` aceptan `zone_id`. `listStores` ya filtrará por scope vía la función SQL.
- `dashboard.functions.ts`:
  - Nuevo `getEmployeeWeeklyMarks({ employeeId, range })` con rangos: `current_week`, `previous_week`, `current_month`, `payroll` (fechas inicio/fin), entregando por día: marcajes, primera entrada, última salida, horas trabajadas.
  - `getEmployeeSummary` agrega filtros por rol y rango (Lunes-Domingo).
  - Métricas de tienda incluyen breakdown por rol.

## 3. UI Admin

- **Panel Tiendas**: selector de Zona al crear/editar tienda; columna Zona en la tabla.
- **Nueva pestaña Zonas** (visible para admin/operaciones): CRUD de zonas + asignar Gerentes de Zona (email).
- **Panel Tiendas → Gerentes**: ya existe `store_managers`; etiquetar como "Gerente de Tienda".
- **Nueva pestaña Usuarios admin** (admin/operaciones): listar Gerentes de Operaciones y crear/eliminar (insert en `user_roles`).
- **Dashboard**:
  - Tarjetas por rol (Cajero, Agente MBK, Seguridad, etc.) con entradas/salidas hoy.
  - Tabla por colaborador: días marcados, marcajes totales, horas, último marcaje.
  - Click en colaborador → modal "Marcaje semanal" con selector de rango (Semana actual / Semana anterior / Mes / Semana planilla con date pickers) y grilla diaria Lun-Dom.

## 4. Acceso
- Layout `admin.tsx`: permitir entrar si el usuario tiene cualquiera de los roles administrativos (no sólo `admin`).
- Visibilidad de pestañas según rol (Zonas y Usuarios admin sólo admin/operaciones).

## Detalles técnicos
- Semana calendario ISO (Lunes-Domingo) calculada en server.
- "Semana planilla" = parámetros `from`/`to` enviados por la UI.
- Operaciones y Admin tienen permisos equivalentes salvo gestión de roles admin (sólo admin general).
- Reescribir `getScope` como función SQL reutilizada por todos los server-fns que filtran por tienda evita duplicación.
