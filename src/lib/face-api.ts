/**
 * Reconocimiento facial en el navegador con @vladmandic/face-api.
 *
 * La librería (TF.js, ~1.3MB) y los modelos se cargan desde el CDN de jsdelivr
 * EN RUNTIME; NO se empaquetan con Vite (el comentario vite-ignore evita que el
 * bundler intente meter TF.js en el bundle de servidor —causaba OOM— o de
 * cliente). Solo corre en el navegador (las funciones se llaman desde la UI).
 *
 * Usado para el ENROLAMIENTO (foto de referencia al crear colaborador) y para el
 * MARCAJE (descriptor de la selfie, que el servidor compara contra la referencia).
 */

const VERSION = "1.7.15";
const MODEL_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VERSION}/model`;
const LIB_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VERSION}/dist/face-api.esm.js`;

// Tipo solo en tiempo de compilación (no genera import en el bundle).
type FaceApi = typeof import("@vladmandic/face-api");

let _faceapi: FaceApi | null = null;
let _loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<FaceApi> {
  if (typeof window === "undefined") throw new Error("face-api solo corre en el navegador");
  if (_faceapi) return _faceapi;
  if (!_loading) {
    _loading = (async () => {
      const faceapi = (await import(/* @vite-ignore */ LIB_URL)) as unknown as FaceApi;
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      _faceapi = faceapi;
    })();
  }
  await _loading;
  return _faceapi!;
}

/** Precarga la librería y los modelos (llamar al abrir la cámara). */
export async function loadFaceModels(): Promise<void> {
  try {
    await ensureLoaded();
  } catch {
    /* silencioso: si falla el CDN, computeDescriptor lo reportará al usarse */
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo procesar la imagen"));
    img.src = dataUrl;
  });
}

/**
 * Descriptor (128 floats) de la cara en la imagen. Lanza error si no detecta un
 * rostro o si el motor no pudo cargar.
 */
export async function computeDescriptorFromDataUrl(dataUrl: string): Promise<number[]> {
  const faceapi = await ensureLoaded();
  const img = await loadImage(dataUrl);
  const det = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det) throw new Error("No se detectó un rostro. Acomódate de frente a la cámara.");
  return Array.from(det.descriptor);
}
