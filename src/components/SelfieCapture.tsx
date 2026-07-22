import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, RotateCcw, Loader2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  computeDescriptorFromDataUrl,
  loadFaceModels,
  runLivenessCheck,
  isLowEndDevice,
  type LivenessHandle,
} from "@/lib/face-api";

interface Props {
  /** Recibe la foto (data URL) y el descriptor facial 128-d (o null si no se pudo calcular). */
  onCapture: (dataUrl: string, descriptor: number[] | null) => void;
  onCancel?: () => void;
  /** Texto del botón de confirmar (por defecto "Confirmar marcaje"). */
  confirmLabel?: string;
  /** Si true (enrolamiento), exige detectar un rostro antes de continuar. */
  requireDescriptor?: boolean;
  /** Si true (marcaje), exige una prueba de vida (parpadeo) antes de tomar la selfie. */
  requireLiveness?: boolean;
}

// "scanning" = corriendo la prueba de vida; "manual" = captura manual (enrolamiento,
// o fallback si el parpadeo falla / no carga el motor).
type LiveState = "scanning" | "manual";

// El enlace abierto DENTRO de otra app (WhatsApp, Facebook, Instagram) corre en un
// WebView: no hay barra de direcciones ni candado, y la cámara suele venir denegada
// por la app anfitriona. Ahí el consejo de "toca el candado" es imposible de seguir.
const isInAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|WhatsApp|; wv\)/i.test(navigator.userAgent || "");

// Primero pedimos la cámara frontal; si el equipo no la soporta, reintentamos sin exigir nada.
const CAM_CONSTRAINTS: MediaStreamConstraints[] = [
  { video: { facingMode: "user", width: 640, height: 480 }, audio: false },
  { video: true, audio: false },
];

// Mensaje según la causa REAL. Antes se descartaba el error y siempre se culpaba al
// permiso: el GT revisaba el candado, lo veía permitido y se quedaba atascado.
const cameraErrorMessage = (name: string) => {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return isInAppBrowser()
        ? "Abriste el enlace dentro de otra app (WhatsApp/Facebook) y ahí la cámara está bloqueada. Toca los 3 puntos → «Abrir en Chrome» y marca desde ahí."
        : "La cámara está bloqueada para esta página. Toca el candado 🔒 en la barra de direcciones → Permisos → Cámara → Permitir, y reintenta.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "Otra aplicación está usando la cámara. Cierra la app de Cámara y las otras pestañas del marcaje, y reintenta.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "Este equipo no tiene cámara disponible. Marca desde la tablet de la tienda.";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "No se pudo iniciar la cámara de este equipo. Reintenta; si sigue, cierra y vuelve a abrir el navegador.";
    default:
      return "No se pudo abrir la cámara. Reintenta; si sigue, cierra y vuelve a abrir el navegador.";
  }
};

export function SelfieCapture({
  onCapture,
  onCancel,
  confirmLabel,
  requireDescriptor,
  requireLiveness,
}: Props) {
  // En tablets de gama baja (poca RAM / CPU débil, ej. 3 GB + Unisoc T310) el bucle
  // del parpadeo bloquea el navegador ("Chrome no responde"); ahí se omite y se usa
  // captura manual directa (el match facial corre una sola vez, al confirmar).
  const useLiveness = requireLiveness && !isLowEndDevice();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const livenessHandle = useRef<LivenessHandle>({ cancel: () => {} });
  const scanningRef = useRef(false);
  const mountedRef = useRef(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nombre técnico del fallo (NotAllowedError, NotReadableError…). Se muestra pequeño para
  // que en el piloto baste una captura de pantalla para saber la causa.
  const [errCode, setErrCode] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(useLiveness ? "scanning" : "manual");
  const [liveMsg, setLiveMsg] = useState<string | null>(null);
  const [faceSeen, setFaceSeen] = useState(false);

  const snap = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    // Calidad suficiente para que el reconocimiento facial sea estable, con una
    // compresión moderada (≈70-100 KB). Bajar más (p.ej. 512/0.62) degradaba el
    // descriptor y causaba falsos rechazos.
    const MAX = 640;
    const scale = Math.min(1, MAX / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror to match preview
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.78);
    setFaceError(null);
    setPreview(url);
  }, []);

  // Abrir la cámara (reutilizable: el botón "Reintentar cámara" la vuelve a invocar).
  const openCamera = useCallback(() => {
    setError(null);
    setErrCode(null);
    // Precargar los modelos de reconocimiento facial (CDN) mientras el usuario se acomoda.
    loadFaceModels();

    // Sin contexto seguro (http://IP en vez de https://) el navegador ni siquiera expone
    // la API: sin esta guarda reventaba con un TypeError fuera del .catch (pantalla en blanco).
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrCode("sin-api");
      setError(
        window.isSecureContext === false
          ? "El navegador bloquea la cámara porque la página no se abrió con https. Usa el enlace oficial del marcaje y reintenta."
          : "Este navegador no permite usar la cámara. Abre el enlace en Chrome (Android) o Safari (iPad).",
      );
      return;
    }

    const attempt = (idx: number, retriedBusy: boolean) => {
      navigator.mediaDevices
        .getUserMedia(CAM_CONSTRAINTS[idx])
        .then((s) => {
          if (!mountedRef.current) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          setStream(s);
          if (videoRef.current) {
            videoRef.current.srcObject = s;
            videoRef.current.play().catch(() => {});
          }
        })
        .catch((e: unknown) => {
          if (!mountedRef.current) return;
          const name = (e as DOMException)?.name || "Error";
          // La tablet no soporta lo que pedimos → reintentar con la cámara "como sea".
          if (name !== "NotAllowedError" && idx + 1 < CAM_CONSTRAINTS.length) {
            attempt(idx + 1, retriedBusy);
            return;
          }
          // Cámara ocupada: casi siempre es la pantalla anterior soltando el stream,
          // así que un reintento corto lo resuelve sin que el usuario haga nada.
          if ((name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") && !retriedBusy) {
            window.setTimeout(() => {
              if (mountedRef.current) attempt(0, true);
            }, 900);
            return;
          }
          setErrCode(name);
          setError(cameraErrorMessage(name));
        });
    };
    attempt(0, false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    openCamera();
    return () => {
      mountedRef.current = false;
    };
  }, [openCamera]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  // Prueba de vida (parpadeo). Solo en marcaje. Al detectar el parpadeo, toma la selfie
  // con los ojos ya abiertos. Si no detecta (timeout/sin rostro) o el motor no carga,
  // cae a captura manual (el servidor sigue validando la selfie con Gemini).
  const startLiveness = useCallback(async () => {
    if (!useLiveness) return;
    const video = videoRef.current;
    if (!video || scanningRef.current) return;
    scanningRef.current = true;
    setLive("scanning");
    setLiveMsg(null);
    setFaceSeen(false);
    try {
      const res = await runLivenessCheck(video, {
        blinksRequired: 1,
        timeoutMs: 6000,
        handle: livenessHandle.current,
        onProgress: (p) => setFaceSeen(p.faceDetected),
      });
      if (res.ok) {
        snap(); // captura con los ojos ya abiertos tras el parpadeo
      } else if (res.reason === "cancelled") {
        /* desmontado o reinicio: no hacer nada */
      } else if (res.reason === "unavailable") {
        setLive("manual");
        setLiveMsg("No se pudo iniciar la prueba de vida. Toma la selfie.");
      } else if (res.reason === "no-face") {
        setLive("manual");
        setLiveMsg("No detectamos tu rostro. Acércate a la cámara e inténtalo de nuevo.");
      } else {
        setLive("manual");
        setLiveMsg("No detectamos un parpadeo. Inténtalo de nuevo o toma la selfie.");
      }
    } finally {
      scanningRef.current = false;
    }
  }, [useLiveness, snap]);

  // Arrancar el parpadeo cuando hay cámara y no hay foto tomada. Al retomar (preview→null)
  // el efecto se re-ejecuta y vuelve a pedir el parpadeo. Cancela el loop al desmontar.
  useEffect(() => {
    if (useLiveness && stream && !preview) {
      startLiveness();
    }
    return () => {
      livenessHandle.current.cancel();
    };
  }, [useLiveness, stream, preview, startLiveness]);

  const retake = () => {
    setPreview(null);
    setFaceError(null);
  };

  const confirm = async () => {
    if (!preview || computing) return;
    setComputing(true);
    setFaceError(null);
    let descriptor: number[] | null = null;
    try {
      descriptor = await computeDescriptorFromDataUrl(preview);
    } catch (e) {
      descriptor = null;
      if (requireDescriptor) {
        // En enrolamiento es obligatorio detectar el rostro.
        setFaceError(e instanceof Error ? e.message : "No se detectó un rostro. Repite la foto.");
        setComputing(false);
        return;
      }
      // En marcaje degradamos: el servidor decide (Gemini valida la selfie y,
      // si el colaborador está enrolado, exigirá el match).
    }
    setComputing(false);
    onCapture(preview, descriptor);
  };

  const scanning = useLiveness && live === "scanning" && !preview && !error;

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div className="relative w-full max-w-md aspect-[4/3] overflow-hidden rounded-2xl border-2 border-border bg-black shadow-[var(--shadow-soft)]">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center p-6 text-destructive-foreground bg-destructive/80">
            <span>{error}</span>
            {errCode && <span className="text-[11px] opacity-70">código: {errCode}</span>}
          </div>
        ) : preview ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img src={preview} className="w-full h-full object-cover" />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover scale-x-[-1]"
          />
        )}
        <div className="absolute inset-0 pointer-events-none rounded-2xl ring-1 ring-inset ring-white/10" />

        {/* Overlay de la prueba de vida */}
        {scanning && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
            <div className="flex items-center justify-center gap-2 text-white text-sm font-medium">
              {faceSeen ? (
                <>
                  <Eye className="h-5 w-5 animate-pulse" />
                  Parpadea para confirmar que eres tú
                </>
              ) : (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Centra tu rostro, o toca Tomar selfie
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />

      {liveMsg && !preview && (
        <p className="text-sm text-muted-foreground text-center -mt-1">{liveMsg}</p>
      )}
      {faceError && (
        <p className="text-sm text-destructive text-center -mt-1">{faceError}</p>
      )}

      <div className="flex gap-3 w-full max-w-md">
        {error ? (
          // Cámara denegada/no disponible: estado claro + reintentar (no overlay de escaneo).
          <>
            {onCancel && (
              <Button type="button" variant="outline" className="h-14 px-6" onClick={onCancel}>
                Cancelar
              </Button>
            )}
            <Button
              type="button"
              className="flex-1 h-14 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={openCamera}
            >
              <Camera className="mr-2 h-5 w-5" />
              Reintentar cámara
            </Button>
          </>
        ) : preview ? (
          <>
            <Button type="button" variant="outline" className="flex-1 h-14" onClick={retake} disabled={computing}>
              <RotateCcw className="mr-2 h-5 w-5" />
              Repetir
            </Button>
            <Button
              type="button"
              className="flex-1 h-14 bg-accent text-accent-foreground hover:bg-accent/90"
              onClick={confirm}
              disabled={computing}
            >
              {computing ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Verificando rostro…
                </>
              ) : (
                confirmLabel ?? "Confirmar marcaje"
              )}
            </Button>
          </>
        ) : scanning ? (
          // Durante el parpadeo la captura es automática, PERO el botón manual SIEMPRE
          // está disponible: así nadie queda atascado si la cámara no detecta el rostro
          // (mala posición/luz) o si los modelos tardan en cargar.
          <>
            {onCancel && (
              <Button type="button" variant="outline" className="h-14 px-6" onClick={onCancel}>
                Cancelar
              </Button>
            )}
            <Button
              type="button"
              className="flex-1 h-14 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={snap}
            >
              <Camera className="mr-2 h-5 w-5" />
              Tomar selfie
            </Button>
          </>
        ) : (
          <>
            {onCancel && (
              <Button type="button" variant="outline" className="h-14 px-6" onClick={onCancel}>
                Cancelar
              </Button>
            )}
            {useLiveness && (
              <Button type="button" variant="outline" className="h-14 px-4" onClick={startLiveness}>
                <Eye className="mr-2 h-5 w-5" />
                Reintentar
              </Button>
            )}
            <Button
              type="button"
              className="flex-1 h-14 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={snap}
              disabled={!!error}
            >
              <Camera className="mr-2 h-5 w-5" />
              Tomar selfie
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
