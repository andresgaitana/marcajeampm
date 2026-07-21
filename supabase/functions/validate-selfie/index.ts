// Supabase Edge Function (Deno): validación de selfie con Vertex AI (Gemini).
//
// Autentica con un SERVICE ACCOUNT (OAuth2 JWT → access token) y llama a Vertex AI
// generateContent. Reemplaza la API key de AI Studio por el camino empresarial de
// Google Cloud, con el secreto guardado en Supabase (nunca en el repo ni en el cliente).
//
// Política: FAIL-OPEN ante problemas de SERVICIO (sin secreto, token/Vertex caído,
// 429, 5xx, red, JSON inválido) → devuelve un verdict neutro y NO bloquea el marcaje.
// Solo bloquea cuando Vertex SÍ respondió y detectó un problema real de la foto.
//
// Secretos / config (Supabase → Edge Functions → Secrets):
//   VERTEX_SA_JSON     (obligatorio) el JSON del service account, en una sola línea
//   VERTEX_PROJECT_ID  (opcional, default 'ampm-marcaje')
//   VERTEX_LOCATION    (opcional, default 'us-central1')
//   VERTEX_MODEL       (opcional, default 'gemini-2.5-flash')

const PROJECT_ID = Deno.env.get("VERTEX_PROJECT_ID") ?? "ampm-marcaje";
const LOCATION = Deno.env.get("VERTEX_LOCATION") ?? "us-central1";
const MODEL = Deno.env.get("VERTEX_MODEL") ?? "gemini-2.5-flash";

const SYSTEM_PROMPT = `Eres un validador de selfies para un sistema de marcaje de asistencia. Recibes una imagen y devuelves SOLO un JSON estricto con este esquema:
{
  "is_person": boolean,            // true si hay una persona real (rostro humano vivo) en la foto
  "face_count": number,            // cantidad de rostros humanos visibles
  "is_blank": boolean,             // true si la imagen está en negro, blanco, totalmente borrosa o vacía
  "is_screen": boolean,            // true si es foto de una pantalla (monitor, celular, tablet)
  "is_photo_of_photo": boolean,    // true si es foto de otra foto impresa, carnet, póster o ID
  "lighting_ok": boolean,          // true si la iluminación permite ver el rostro
  "confidence": number,            // 0..1 qué tan seguro estás de tu verdict
  "reason": string                 // breve explicación en español (máx 200 chars)
}
No agregues texto fuera del JSON. No uses markdown.`;

// Verdict neutro: el marcaje continúa (la identidad la cubren el match facial + geocerca).
const SKIP = {
  ok: true,
  verdict: {
    is_person: true,
    face_count: 1,
    is_blank: false,
    is_screen: false,
    is_photo_of_photo: false,
    lighting_ok: true,
    confidence: 0,
    reason: "Validación omitida (servicio no disponible)",
  },
};

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlStr(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

type ServiceAccount = { client_email: string; private_key: string; token_uri: string };

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64urlStr(JSON.stringify(header))}.${base64urlStr(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = await res.json();
  return j.access_token as string;
}

function reject(error: string, verdict: unknown) {
  return Response.json({ ok: false, error, verdict });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json(SKIP);
  try {
    const { dataUrl } = await req.json().catch(() => ({}));
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl ?? "");
    if (!m) return Response.json(SKIP); // imagen ilegible: no bloquear

    const saRaw = Deno.env.get("VERTEX_SA_JSON");
    if (!saRaw) return Response.json(SKIP); // sin secreto configurado: fail-open

    let token: string;
    try {
      token = await getAccessToken(JSON.parse(saRaw) as ServiceAccount);
    } catch (_e) {
      return Response.json(SKIP); // no se pudo autenticar con Google: fail-open
    }

    const url =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
      `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Valida esta selfie y responde solo con el JSON pedido." },
              { inlineData: { mimeType: m[1], data: m[2] } },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) return Response.json(SKIP); // 429/5xx/etc: fail-open

    const j = await r.json();
    const text: string = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim());
    } catch {
      return Response.json(SKIP); // respuesta no-JSON: fail-open
    }

    // Rechazos: solo cuando Vertex vio un problema REAL de la foto. La IDENTIDAD la
    // verifica el match facial (face-api) aparte, así que NO rechazamos por baja "confidence"
    // (mide la certeza del verdict, no la calidad) ni por "quizá no hay rostro": eso causaba
    // falsos rechazos frecuentes con cámaras de tablet (→ bloqueos por selfie).
    const conf = typeof v.confidence === "number" ? v.confidence : 0;
    if (v.is_blank) return reject("La foto está en blanco o borrosa. Acomódate frente a la cámara.", v);
    if (v.is_screen) return reject("No se permite tomar foto de una pantalla.", v);
    if (v.is_photo_of_photo) return reject("No se permite tomar foto de otra foto o documento.", v);
    if (conf >= 0.6 && (!v.is_person || v.face_count === 0)) return reject("No se detectó un rostro. Mira directamente a la cámara.", v);
    if (conf >= 0.6 && typeof v.face_count === "number" && v.face_count > 1)
      return reject("Hay más de una persona en la foto. Solo debe aparecer quien marca.", v);

    return Response.json({ ok: true, verdict: v });
  } catch (_e) {
    return Response.json(SKIP); // cualquier error inesperado: fail-open
  }
});
