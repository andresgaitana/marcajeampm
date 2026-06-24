# Manual del Super Administrador
### Sistema de Marcaje · AM/PM Centroamérica

> Nivel con acceso total: todas las tiendas, todas las zonas, configuración y usuarios.
> Super administradores: **Marco López, Andrés Gaitán, Vilma Berríos, Rodolfo Castillo.**

---

## 1. Cómo entrar
1. Abre `https://marcajeampm.vercel.app/admin`
2. **Correo:** el tuyo (ej. `andres.gaitan@ampm.com.ni`, `rodolfo.castillo@ampmcentroamerica.com`, etc.).
3. **Contraseña inicial:** `Admin2026!` (cámbiala apenas entres).
4. Ojo 👁 para ver la contraseña; **"¿Olvidaste tu contraseña?"** envía correo de restablecimiento.

---

## 2. Las pestañas del panel
| Pestaña | Para qué |
|---|---|
| **Dashboard** | Métricas en vivo: entradas/salidas hoy, quién está dentro, alertas. |
| **Horario** | Quién marcó por turno (AM/PM) y área, por tienda y semana. |
| **Marcajes** | Historial detallado de marcajes (con selfie). |
| **Colaboradores** | Crear/editar/eliminar colaboradores de cualquier tienda; foto y PIN. |
| **Tiendas** | Configurar tiendas: PIN de terminal, **coordenadas**, **radio**, zona. |
| **Zonas** | Crear/editar zonas. |
| **Usuarios admin** | Crear/asignar Administradores, Gerentes de Operaciones, de Zona y de Tienda. |

---

## 3. Modelo de acceso (resumen)
| Nivel | Entra en | Ve / administra |
|---|---|---|
| **Super admin / Operaciones** | `/admin` | **Todo** (todas las tiendas y zonas) |
| **Gerente de Zona** | `/admin` | Solo **su zona** (todas sus tiendas) |
| **Gerente de Tienda** | `/admin` | Solo **su tienda** (sin configuración) |
| **Colaboradores** | Tablet `/` | Solo marcan (no entran al panel) |

---

## 4. Dar de alta un usuario administrador (GT / GZ / Operaciones / Admin)
Pestaña **Usuarios admin** → completa correo, rol y contraseña inicial:
- **Gerente de Tienda:** asígnale **su tienda**.
- **Gerente de Zona:** asígnale **su(s) zona(s)** (verá todas las tiendas de esas zonas).
- **Gerente de Operaciones / Administrador:** acceso total (solo un Administrador puede crear estos dos).

> También hay botones de carga masiva (sembrar los 87 GT, los 10 GZ, etc.) para la configuración inicial.

---

## 5. Configurar una tienda y su tablet (onboarding)
**A) En el panel (pestaña Tiendas → editar la tienda):**
- **PIN de terminal:** el código con el que se vincula la tablet (no lo sabe el personal de caja).
- **Coordenadas (latitud/longitud):** ubicación real de la tienda (para la geocerca).
- **Radio de geocerca:** distancia máxima permitida (por defecto **300 m**).
- **Zona** a la que pertenece.

**B) En la tablet de la tienda** (`https://marcajeampm.vercel.app/`):
1. Abre el enlace → **Configurar terminal**.
2. Escribe el **código de tienda** (ej. `A03`) + el **PIN de terminal**.
3. **Vincular**. La tablet queda fija a esa tienda (se guarda en el dispositivo).

> Hazlo **una sola vez por tablet**. Si cambias de equipo, repites el paso.

---

## 6. La geocerca y las tablets WiFi (importante)
El marcaje exige que la ubicación reportada caiga **dentro del radio** de la tienda (300 m). **No exige precisión de GPS**, porque las terminales son **tablets WiFi** (ubican por WiFi/IP).

**Si un colaborador no puede marcar y aparece "Estás a X m de la tienda":**
- Significa que el WiFi de esa tienda ubica corrido.
- **Solución:** Pestaña **Tiendas** → editar la tienda → subir el **Radio de geocerca** (ej. de 300 a 800–1000 m) → **Guardar**. Ajusta por tienda según lo que reporte.

---

## 7. Reconocimiento facial
- La **foto de referencia** se toma al crear/editar a cada colaborador (la toma su GT/GZ).
- Al marcar, la selfie se compara con esa foto.
- **Modo tolerante:** quien aún no tiene foto puede marcar hasta que se la tomen.
- Si "el rostro no coincide", un **supervisor (GT o GZ con autoridad en la tienda)** puede autorizar el marcaje con su **código + PIN** (queda registrado quién autorizó).

---

## 8. Restablecer credenciales
- **PIN de marcaje (cualquier persona):** Colaboradores → botón **llave 🔑** → queda en **`1234`** y la persona debe cambiarlo en su próximo marcaje. Como super admin puedes hacerlo a **cualquier nivel**.
- **Contraseña del panel:**
  - Si el correo es un **buzón real** (admins, GZ): usa **"¿Olvidaste tu contraseña?"** en el login.
  - Para los **logins genéricos** `jefe.ampmXX@` (que no son buzones reales): el restablecimiento se gestiona con el administrador del sistema.

---

## 9. Revisión diaria
- **Dashboard:** entradas/salidas del día, quién está dentro, alertas (sesiones abiertas > 10 h).
- **Horario:** por tienda y semana, quién marcó en cada turno (Productos/MBK · AM/PM).
- **Marcajes:** historial con selfie y ubicación de cada marcaje.

---

## 10. Tabla de credenciales (referencia)
| Nivel | Entra en | Usuario | Clave / PIN inicial |
|---|---|---|---|
| Super admin | `/admin` | correo del admin | `Admin2026!` |
| Gerente de Zona | `/admin` | `<nombre>@ampm.com.ni` | `Ampm2026!` |
| Gerente de Tienda | `/admin` | `jefe.ampmXX@ampm.com.ni` | `Ampm2026!` |
| Marcaje GT | Tablet | `GT-AXX` | `1234` |
| Marcaje GZ | Tablet | `GZ-<zona>` | `1234` |
| Marcaje colaborador | Tablet | código que pone el GT | PIN que pone el GT |

> Todas las claves/PIN de arranque (`Admin2026!`, `Ampm2026!`, `1234`, PIN de terminal) deben **cambiarse** una vez en operación.

---

### Tareas típicas (atajos)
- **Nueva tienda:** Tiendas → crear (código, nombre, PIN terminal, coordenadas, zona) → vincular su tablet.
- **Nuevo GT/GZ:** Usuarios admin → crear → asignar tienda/zona.
- **Ampliar radio:** Tiendas → editar → Radio de geocerca → guardar.
- **Restablecer PIN:** Colaboradores → 🔑.
