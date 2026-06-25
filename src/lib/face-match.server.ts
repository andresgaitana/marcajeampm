/**
 * Comparación de descriptores faciales (128 floats) en el servidor.
 * Distancia euclidiana < umbral => misma persona. El descriptor de referencia
 * (employees.face_descriptor) NUNCA viaja al cliente; solo se compara aquí.
 */

// Umbral de coincidencia. Con face_recognition_model, distancias < 0.6 suelen ser
// la misma persona (0.6 es el valor estándar de la librería). Subido de 0.55 a
// 0.6 para reducir falsos rechazos por luz/ángulo/compresión. Configurable por env.
export const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? "0.6");

export function euclideanDistance(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 128 || b.length !== 128) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** true si los descriptores corresponden a la misma persona. */
export function facesMatch(reference: number[], candidate: number[]): boolean {
  return euclideanDistance(reference, candidate) < FACE_MATCH_THRESHOLD;
}
