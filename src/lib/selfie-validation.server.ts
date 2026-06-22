import { z } from "zod";

/**
 * Server-only Gemini-powered selfie validator.
 *
 * Calls the Google Generative Language API (Gemini) directly with the selfie
 * image and asks for a structured JSON verdict. Used to block:
 * - photos that do not contain a real human face
 * - blank / black / heavily blurred frames
 * - photos of a screen / display
 * - photos of a printed photo / id card / object
 *
 * Requires the GEMINI_API_KEY env var (create a free key at
 * https://aistudio.google.com/app/apikey). This replaces the previous
 * dependency on the Lovable AI Gateway so the app is independent of Lovable.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const verdictSchema = z.object({
  is_person: z.boolean(),
  face_count: z.number().int().min(0).max(20),
  is_blank: z.boolean(),
  is_screen: z.boolean(),
  is_photo_of_photo: z.boolean(),
  lighting_ok: z.boolean().optional().default(true),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300).optional().default(""),
});

export type SelfieVerdict = z.infer<typeof verdictSchema>;

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

/** Splits a data URL (data:<mime>;base64,<data>) into its mime type and raw base64. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export async function validateSelfie(dataUrl: string): Promise<{
  ok: true;
  verdict: SelfieVerdict;
} | { ok: false; error: string; verdict?: SelfieVerdict }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Fail closed if AI is not configured — block the marcaje with a clear message.
    console.warn("[selfie-validation] GEMINI_API_KEY missing, cannot validate");
    return { ok: false, error: "Validación con IA no configurada. Contacta al administrador." };
  }

  const image = parseDataUrl(dataUrl);
  if (!image) {
    console.error("[selfie-validation] invalid data URL");
    return { ok: false, error: "No se pudo leer la selfie. Intenta de nuevo." };
  }

  let raw: string;
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: "Valida esta selfie y responde solo con el JSON pedido." },
              { inline_data: { mime_type: image.mimeType, data: image.data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    });
    if (res.status === 429) return { ok: false, error: "Servicio de validación saturado. Intenta de nuevo en unos segundos." };
    if (res.status === 401 || res.status === 403) {
      const txt = await res.text().catch(() => "");
      console.error("[selfie-validation] gemini auth error", res.status, txt);
      return { ok: false, error: "Validación con IA no configurada. Contacta al administrador." };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[selfie-validation] gemini error", res.status, txt);
      return { ok: false, error: "No se pudo validar la selfie. Intenta de nuevo." };
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch (e) {
    console.error("[selfie-validation] fetch failed", e);
    return { ok: false, error: "No se pudo validar la selfie. Intenta de nuevo." };
  }

  let parsed: unknown;
  try {
    // Strip accidental markdown fences if any
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[selfie-validation] non-JSON output", raw);
    return { ok: false, error: "Respuesta de validación inválida. Intenta de nuevo." };
  }

  const result = verdictSchema.safeParse(parsed);
  if (!result.success) {
    console.error("[selfie-validation] schema mismatch", result.error.flatten());
    return { ok: false, error: "Respuesta de validación inválida. Intenta de nuevo." };
  }
  const v = result.data;
  console.log("[selfie-validation] verdict", JSON.stringify(v));

  // Reject reasons (in order)
  if (v.is_blank) return { ok: false, error: "La foto está en blanco o borrosa. Acomódate frente a la cámara.", verdict: v };
  if (v.is_screen) return { ok: false, error: "No se permite tomar foto de una pantalla.", verdict: v };
  if (v.is_photo_of_photo) return { ok: false, error: "No se permite tomar foto de otra foto o documento.", verdict: v };
  if (!v.is_person || v.face_count === 0) return { ok: false, error: "No se detectó un rostro. Mira directamente a la cámara.", verdict: v };
  if (v.face_count > 1) return { ok: false, error: "Hay más de una persona en la foto. Solo debe aparecer quien marca.", verdict: v };
  if (v.confidence < 0.6) return { ok: false, error: "No se pudo confirmar tu identidad en la foto. Reintenta con mejor luz.", verdict: v };

  return { ok: true, verdict: v };
}
