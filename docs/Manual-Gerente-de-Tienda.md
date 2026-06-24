# Manual del Gerente de Tienda (GT)
### Sistema de Marcaje · AM/PM Centroamérica

---

## 1. ¿Qué es y para qué sirve?
Es el sistema con el que tu equipo registra su **entrada y salida**. Cada marcaje queda con:
- **Selfie en vivo** + **reconocimiento facial** (confirma que es la persona correcta).
- **Ubicación** (confirma que se marcó en la tienda).
- Hora exacta.

Tú, como Gerente de Tienda, **administras a los colaboradores de tu tienda** y revisas su asistencia. Ellos marcan en la **tablet** del local.

---

## 2. Tus dos pantallas (mismo enlace, distinto uso)

| | **Administración** (tu compu o celular) | **Marcaje** (la tablet de la tienda) |
|---|---|---|
| Enlace | `https://marcajeampm.vercel.app/admin` | `https://marcajeampm.vercel.app/` |
| Para qué | Crear colaboradores, ver asistencia | Que el equipo marque entrada/salida |
| Cómo entras | Con tu **correo y contraseña** | Ya queda configurada (no necesitas entrar) |

> En tu computadora entra **directo a `/admin`**. No configures la tablet desde la compu.

---

## 3. Cómo entrar al panel de administración
1. Abre `https://marcajeampm.vercel.app/admin`
2. **Correo:** `jefe.ampmXX@ampm.com.ni` — donde **XX = número de tu tienda** (ej. tienda A03 → `jefe.ampm03@ampm.com.ni`).
3. **Contraseña inicial:** `Ampm2026!`
4. Toca el **ojo 👁** para ver lo que escribes. Si la olvidas, usa **"¿Olvidaste tu contraseña?"**.

> Cambia tu contraseña inicial apenas entres (ver sección 9).

---

## 4. Qué puedes hacer y qué no

**✅ Puedes:**
- Crear, editar y eliminar a **tus colaboradores**: Cajero, Agente MBK y Seguridad.
- Tomarles la **foto de referencia** (reconocimiento facial).
- Asignarles y **restablecer su PIN**.
- Ver el **Dashboard**, el **Horario** y los **Marcajes** de **tu tienda**.

**❌ No puedes (por diseño):**
- Tocar la **configuración de la tienda**.
- Crear o borrar **Gerentes** o **Gerentes de Zona**.
- Ver otras tiendas.

---

## 5. Crear un colaborador (paso a paso)
> Hazlo **con la persona presente**, para tomar su foto real.

1. En el panel, entra a la pestaña **Colaboradores**.
2. Botón **+ Nuevo colaborador**.
3. Llena:
   - **Código de empleado:** un código simple y único (ej. el número de empleado).
   - **Nombre completo.**
   - **Rol:** Cajero, Agente MBK o Seguridad.
   - **Tienda:** la tuya.
   - **PIN (4–8 dígitos):** el que usará para marcar.
4. En **Foto de referencia** → **Tomar foto** → la persona mira a la cámara → **Usar esta foto**. *(Obligatoria al crear.)*
5. Deja **Activo** marcado y toca **Guardar**.

Listo: esa persona ya puede marcar con su **código + PIN + selfie**.

---

## 6. Restablecer el PIN de un agente
Si un agente olvida su PIN:
1. Pestaña **Colaboradores** → busca a la persona.
2. Toca el botón de **llave 🔑** ("Restablecer PIN").
3. Su PIN queda en **`1234`** y aparecerá la etiqueta **"PIN 1234 · por cambiar"**.
4. En su **próximo marcaje**, el sistema le pedirá **crear un PIN nuevo** (distinto de 1234).

> Como GT solo puedes restablecer el PIN de **tus agentes** (Cajero, MBK, Seguridad).

---

## 7. El Horario — "quién marcó"
Pestaña **Horario**: una grilla de **Lunes a Domingo** que se llena **sola** con los marcajes reales de tu tienda.
- Filas: **Productos AM/PM** y **MBK AM/PM**.
- Cada celda muestra **quién marcó entrada** ese día en ese turno.
- Botones para ver **semana anterior / siguiente**.

> Es solo de lectura (refleja lo que pasó). No es para planificar turnos.

---

## 8. La tablet: cómo marca tu equipo
La tablet ya queda configurada para tu tienda. El colaborador:
1. Elige **ENTRADA** o **SALIDA**.
2. Escribe su **código**.
3. Escribe su **PIN**.
4. Se toma la **selfie**.
5. ¡Listo! Aparece **"ENTRADA/SALIDA REGISTRADA"**.

**Tu propio marcaje (GT):** código **`GT-AXX`** (ej. `GT-A03`) y PIN **`1234`**.

### Si algo falla al marcar:
- **"El rostro no coincide…":** un supervisor (tú como GT, o tu GZ) puede autorizarlo. Aparecerá la pantalla **"Autorización de supervisor"** → escribe tu **código (`GT-AXX`) + tu PIN** → **Autorizar marcaje**. (Queda registrado quién autorizó.)
- **"Activa la ubicación…":** la tablet debe tener la **ubicación activada** y dar permiso al navegador.
- **"Estás a X m de la tienda":** la tablet está fuera del rango. Repórtalo a un Super Administrador para **ampliar el radio** de tu tienda.
- **Selfie inválida:** que la cara se vea clara, con buena luz y sin objetos cubriéndola.

> Importante: la **foto de referencia** debe estar tomada para que el reconocimiento funcione. A quien aún no tenga foto, el sistema lo deja marcar hasta que se la tomes — tómala cuanto antes.

---

## 9. Cambiar tu contraseña / problemas comunes
- **Cambiar contraseña:** usa **"¿Olvidaste tu contraseña?"** en la pantalla de login (te llega un correo, solo si tu correo es un buzón real). Si no, pídele a tu Gerente de Zona o a un Super Administrador que te la restablezca.
- **No puedo entrar:** revisa que el correo sea `jefe.ampmXX@` con el número correcto de tu tienda.
- **La tablet no marca:** revisa internet y que la ubicación esté activada.

---

### Resumen rápido
- Panel: `…/admin` · correo `jefe.ampmXX@ampm.com.ni` · clave inicial `Ampm2026!`
- Tu marcaje: código `GT-AXX`, PIN `1234`
- Crear agente: Colaboradores → + Nuevo → foto + PIN
- Restablecer PIN: 🔑 → queda en `1234`
