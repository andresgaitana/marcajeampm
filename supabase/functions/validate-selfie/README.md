# validate-selfie — Edge Function (OPCIÓN ARCHIVADA)

Validación de selfie con **Vertex AI (Gemini)** usando un **service account**.
Es una **capa extra opcional** (detección de pantalla / foto-de-foto). **No es
necesaria para que la app funcione.**

## Estado actual: ARCHIVADA / APAGADA

El piloto corre **sin esta función**, 100% local y gratis:
**parpadeo (liveness) + reconocimiento facial + enrolamiento obligatorio + geocerca.**

La función está **desplegada pero inerte**: si no existe el secreto `VERTEX_SA_JSON`
hace *fail-open* (no bloquea). Y la app solo la llama si `SELFIE_VALIDATOR=edge`.

## Cómo encenderla en el futuro

1. **Service account** en Google Cloud (proyecto `ampm-marcaje`):
   - Crear/rotar la clave del service account (descargar el JSON).
   - Habilitar la **Vertex AI API** y dar el rol **Vertex AI User** a esa cuenta.
2. **Secreto en Supabase** (Dashboard → Edge Functions → Secrets):
   - `VERTEX_SA_JSON` = el JSON del service account en una sola línea.
   - (Opcionales) `VERTEX_PROJECT_ID` (def. `ampm-marcaje`), `VERTEX_LOCATION`
     (def. `us-central1`), `VERTEX_MODEL` (def. `gemini-2.5-flash`).
3. **Activar en la app** (Vercel → Environment Variables):
   - `SELFIE_VALIDATOR=edge` y redeploy.

La app llama a la función con la `SUPABASE_SERVICE_ROLE_KEY` como Bearer
(`verify_jwt` activo). Devuelve `{ ok, verdict, error? }`; ante cualquier fallo de
servicio (sin secreto, token, 429, 5xx, red, JSON inválido) responde *fail-open*.

## Costo

Pago por uso de Vertex AI: ~$0.0006 por foto (mismo precio que Gemini Flash).
Ver la nota de costo en la memoria del proyecto (`marcaje-gemini-costo`).
