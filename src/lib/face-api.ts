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
    })().catch((e) => {
      // Un hipo del CDN (WiFi de tienda) dejaba la promesa rechazada CACHEADA para
      // siempre: la tablet quedaba sin reconocimiento hasta recargar. Se limpia para
      // que el siguiente intento vuelva a cargar los modelos.
      _loading = null;
      throw e;
    });
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
 * Detecta tablets/teléfonos de gama baja (poca RAM / pocos núcleos), donde TF.js
 * corre en CPU y bloquea el navegador ("Chrome no responde"). Ej.: las tablets del
 * piloto con 3 GB de RAM y CPU Unisoc T310 quad-core.
 */
export function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  return (typeof mem === "number" && mem <= 3) || (typeof cores === "number" && cores <= 4);
}

/** Mensaje que distingue el fallo de CARGA (CDN/red) del de NO-HAY-ROSTRO. */
export const FACE_CDN_ERROR =
  "No se pudo cargar el reconocimiento facial. Revisa la conexión de la tienda (WiFi/datos) y reintenta en unos segundos.";
export const FACE_NO_ROSTRO_ERROR =
  "No se detectó un rostro. Busca mejor luz —evita ventanas o lámparas DETRÁS de la persona—, coloca la cara de frente y que llene el recuadro.";

/**
 * Copia de la imagen con brillo y contraste realzados. Contra la retroiluminación
 * (luz fuerte de fondo que deja la cara oscura), que es la causa #1 de que el detector
 * "no vea" un rostro que está clarísimo para el ojo humano.
 */
function brightenedCanvas(img: HTMLImageElement): HTMLCanvasElement | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.filter = "brightness(1.35) contrast(1.25)";
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/**
 * Descriptor (128 floats) de la cara en la imagen. Lanza FACE_CDN_ERROR si el motor no
 * pudo cargar, o FACE_NO_ROSTRO_ERROR si de plano no hay rostro tras varios intentos.
 *
 * Hace VARIAS pasadas de detección, de la más estricta a la más tolerante, y una final
 * sobre una versión aclarada de la foto. Así cubre retroiluminación, poca luz y equipos
 * de gama baja (donde antes un solo intento con umbral estricto fallaba de más).
 */
export async function computeDescriptorFromDataUrl(dataUrl: string): Promise<number[]> {
  let faceapi: FaceApi;
  try {
    faceapi = await ensureLoaded();
  } catch {
    throw new Error(FACE_CDN_ERROR);
  }
  const img = await loadImage(dataUrl);
  const low = isLowEndDevice();
  // De estricto a tolerante. Un umbral menor detecta caras de bajo contraste (contraluz)
  // a costa de más falsos positivos; como es una foto ya encuadrada de una sola persona,
  // el riesgo es bajo y el descriptor se compara luego contra la referencia igual.
  const passes = low
    ? [{ inputSize: 320, scoreThreshold: 0.5 }, { inputSize: 416, scoreThreshold: 0.3 }, { inputSize: 224, scoreThreshold: 0.2 }]
    : [{ inputSize: 416, scoreThreshold: 0.5 }, { inputSize: 512, scoreThreshold: 0.3 }, { inputSize: 608, scoreThreshold: 0.2 }];

  const tryDetect = async (input: HTMLImageElement | HTMLCanvasElement, opts: { inputSize: number; scoreThreshold: number }) =>
    faceapi
      .detectSingleFace(input, new faceapi.TinyFaceDetectorOptions(opts))
      .withFaceLandmarks()
      .withFaceDescriptor();

  for (const p of passes) {
    const det = await tryDetect(img, p);
    if (det) return Array.from(det.descriptor);
  }
  // Último recurso: la misma foto aclarada, contra la retroiluminación.
  const bright = brightenedCanvas(img);
  if (bright) {
    const det = await tryDetect(bright, { inputSize: low ? 416 : 608, scoreThreshold: 0.2 });
    if (det) return Array.from(det.descriptor);
  }
  throw new Error(FACE_NO_ROSTRO_ERROR);
}

/* ───────────────────────── Liveness por parpadeo (anti-foto) ─────────────────────────
 * Puerto del algoritmo EAR (Eye Aspect Ratio) de liveness.py al navegador, usando los
 * landmarks de los ojos que face-api ya calcula. Una foto estática no parpadea; una
 * persona viva sí. Es un reto ACTIVO: pedimos un parpadeo antes de tomar la selfie.
 * Reemplaza el anti-foto que hacía Gemini, gratis y 100% offline en la tablet.            */

const EAR_CLOSED = 0.21; // por debajo = ojo cerrado (mismo umbral que liveness.py)
const EAR_OPEN = 0.26; // por encima = ojo claramente abierto (histéresis anti-ruido)

type Pt = { x: number; y: number };

function eyeAspectRatio(eye: Pt[]): number {
  if (!eye || eye.length < 6) return 1; // sin 6 puntos: asumir abierto (no bloquear)
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const vertical = d(eye[1], eye[5]) + d(eye[2], eye[4]);
  const horizontal = d(eye[0], eye[3]);
  return horizontal === 0 ? 1 : vertical / (2 * horizontal);
}

export interface LivenessProgress {
  faceDetected: boolean;
  blinks: number;
  ear: number | null;
}
export interface LivenessHandle {
  cancel: () => void;
}
export type LivenessResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "no-face" | "cancelled" | "unavailable" };

/**
 * Observa el stream EN VIVO y resuelve cuando detecta el parpadeo requerido (un ciclo
 * cerrar→abrir los ojos). No bloquea la UI: cede el hilo con requestAnimationFrame entre
 * detecciones. Pasar `handle` para poder abortar desde afuera (al desmontar/reintentar).
 */
export async function runLivenessCheck(
  video: HTMLVideoElement,
  opts: {
    blinksRequired?: number;
    timeoutMs?: number;
    onProgress?: (p: LivenessProgress) => void;
    handle?: LivenessHandle;
  } = {},
): Promise<LivenessResult> {
  let faceapi: FaceApi;
  try {
    // Timeout DURO: si el CDN se cuelga (WiFi de tienda saturada, conexión a medio
    // abrir que nunca rechaza), no dejamos al usuario atascado en "scanning" — caemos
    // a captura manual. ensureLoaded() seguirá cacheando en segundo plano para el próximo.
    faceapi = await Promise.race([
      ensureLoaded(),
      new Promise<FaceApi>((_, reject) =>
        setTimeout(() => reject(new Error("model-load-timeout")), 5000),
      ),
    ]);
  } catch {
    return { ok: false, reason: "unavailable" }; // CDN/modelos lentos o caídos: no bloquear
  }
  const blinksRequired = Math.max(1, opts.blinksRequired ?? 1);
  const timeoutMs = opts.timeoutMs ?? 9000;
  const det = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });

  let cancelled = false;
  if (opts.handle) opts.handle.cancel = () => { cancelled = true; };

  const FRAME_MS = 130; // ~7-8 FPS: detecta un parpadeo (100-400ms) sin fijar el CPU
  let blinks = 0;
  let eyesClosed = false; // estado actual con histéresis
  let everSawFace = false;
  const start = performance.now();

  while (performance.now() - start < timeoutMs) {
    if (cancelled) return { ok: false, reason: "cancelled" };
    const t0 = performance.now();
    let ear: number | null = null;
    // No correr la red neuronal si la app está en segundo plano (ahorra batería/CPU).
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      try {
        const r = await faceapi.detectSingleFace(video, det).withFaceLandmarks();
        if (r) {
          everSawFace = true;
          const left = r.landmarks.getLeftEye().map((p) => ({ x: p.x, y: p.y }));
          const right = r.landmarks.getRightEye().map((p) => ({ x: p.x, y: p.y }));
          ear = (eyeAspectRatio(left) + eyeAspectRatio(right)) / 2;
          if (!eyesClosed && ear < EAR_CLOSED) {
            eyesClosed = true; // se cerró el ojo
          } else if (eyesClosed && ear > EAR_OPEN) {
            eyesClosed = false; // se abrió tras cerrarse ⇒ un parpadeo
            blinks += 1;
          }
        }
      } catch {
        /* frame ilegible: ignorar y seguir */
      }
    }
    opts.onProgress?.({ faceDetected: ear !== null, blinks, ear });
    if (blinks >= blinksRequired) return { ok: true };
    // Paceo explícito: cede CPU hasta completar ~FRAME_MS desde el inicio de la iteración
    // (si la detección ya tardó más, avanza de inmediato).
    const wait = Math.max(0, FRAME_MS - (performance.now() - t0));
    await new Promise<void>((res) => setTimeout(res, wait));
  }
  return { ok: false, reason: everSawFace ? "timeout" : "no-face" };
}
