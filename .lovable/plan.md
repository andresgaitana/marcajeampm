
## Objetivo
Crear los 10 Gerentes de Zona (GZ) con su acceso admin restringido a su zona, y habilitar que un GZ pueda marcar entrada/salida desde cualquier tienda de las zonas que tiene asignadas.

## 1. Renombrar zonas para que coincidan con la lista oficial
Las dos zonas con código "FOR_S1" / "FOR_S2" tienen nombre "FOR-S1" / "FOR-S2"; las renombro a **"FOR Sur 1"** y **"FOR Sur 2"** (los códigos no cambian, solo el nombre visible).

## 2. Crear 10 usuarios admin (rol `gerente_zona`) y asignar su zona

Para cada fila se crea el usuario auth con contraseña inicial `Cambiar123!` (el GZ podrá cambiarla luego), se le asigna el rol `gerente_zona` y se vincula a su zona en `user_zone_assignments`:

| Zona | GZ | Email |
|---|---|---|
| MGA Sur | Carlos Sandoval | carlos.sandoval@ampm.com.ni |
| MGA Centro | Cristina Maldonado | cristina.maldonado@ampm.com.ni |
| MGA Norte | Erica Zamora | erica.zamora@ampm.com.ni |
| MGA Noreste | Engels Castellon | engels.castellon@ampm.com.ni |
| FOR Sur 1 | Daniel Centeno | daniel.centeno@ampm.com.ni |
| FOR Occidente | Marcos Zarate | marcos.munoz@ampm.com.ni |
| FOR Norte | Tania Ruiz | tania.ruiz@ampm.com.ni |
| FOR Sur 2 | Cristhian Guzman | cristhian.guzman@ampm.com.ni |
| FOR Centro 2 | Julio Gutierrez | julio.gutierrez@ampm.com.ni |
| FOR Centro 1 | Yuri Reyes | yuri.reyes@ampm.com.ni |

Con esto cada GZ entra en `/admin` y, gracias a `accessible_store_ids`, solo verá las tiendas de su zona (dashboard, marcajes, colaboradores).

## 3. Crear el colaborador (employee) GZ para marcar en tienda
Cada GZ además necesita un registro en `employees` con rol `gerente_zona` y PIN `0000` para marcar. Como un GZ no tiene tienda base, su `store_id` quedará apuntando a una tienda "ancla" de su zona (la primera por código), pero la validación de marcaje no usará ese store_id: usará las zonas asignadas al usuario.

- `employee_code`: GZ01..GZ10
- `pin_hash`: hash de "0000" (ya tenemos uno calculado)
- `role`: `gerente_zona`

## 4. Validación de marcaje por zona
Hoy el flujo de marcaje exige que el empleado pertenezca a la tienda donde se marca. Para el rol `gerente_zona` cambio la regla en `src/lib/attendance.functions.ts`:

- Si el empleado tiene rol `gerente_zona`: aceptar el marcaje si la tienda donde se marca pertenece a alguna de las zonas asignadas al GZ (vía `user_zone_assignments` enlazando con la cuenta admin del GZ por email/`auth_user_id`).
- El `attendance_record` se guarda con el `store_id` real donde marcó (para que cuente en el dashboard de esa tienda y zona).

Para enlazar el `employee` con su cuenta admin uso una columna nueva `employees.auth_user_id uuid null` (solo se rellena para GZ). Así puedo saber qué zonas tiene asignadas el GZ al momento de marcar.

## 5. Tienda DEFAULT
No me confirmaste qué hacer con ella. La dejo activa por ahora; cuando me digas la desactivo o elimino.

## Detalles técnicos
- **Migración SQL** (un solo archivo):
  1. `UPDATE zones SET name='FOR Sur 1' WHERE code='FOR_S1'` y equivalente para S2.
  2. `ALTER TABLE employees ADD COLUMN auth_user_id uuid` (sin FK a auth.users para no tocar ese esquema; índice único parcial).
  3. Insertar 10 usuarios en `auth.users` vía función admin no es posible desde SQL puro — se hace desde una server function (`createGZBatch`) que llama a `supabaseAdmin.auth.admin.createUser` por cada GZ, luego inserta rol, zona y employee.
- **Nueva server fn** `src/lib/admin.functions.ts → seedZoneManagers()`: idempotente (si el email ya existe, reusa el user_id; si el employee_code ya existe, lo actualiza). La ejecuto una vez desde el panel Admin con un botón "Cargar 10 GZ" en la pestaña Usuarios admin (o vía un endpoint puntual).
- **`attendance.functions.ts`**: en el flujo `recordAttendance` (o equivalente), antes de insertar, si `employee.role === 'gerente_zona'` y `employee.auth_user_id` está presente, validar `EXISTS (SELECT 1 FROM stores s JOIN user_zone_assignments uza ON uza.zone_id = s.zone_id WHERE s.id = :store_id AND uza.user_id = employee.auth_user_id)`. Si no, rechazar con "Esta tienda no pertenece a tu zona".
- **PIN**: se mantiene `0000` por ahora (sin cambios).

## Lo que NO se hace en este paso
- Cambiar PIN de tiendas (se mantiene 0000).
- Tocar tienda DEFAULT.
- UI para que el admin cambie las zonas de un GZ desde una pantalla nueva (ya existe en pestaña "Usuarios admin").
