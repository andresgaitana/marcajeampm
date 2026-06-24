import { useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { computeDescriptorFromDataUrl, loadFaceModels } from "@/lib/face-api";

interface Props {
  /** Recibe la foto (data URL) y el descriptor facial 128-d (o null si no se pudo calcular). */
  onCapture: (dataUrl: string, descriptor: number[] | null) => void;
  onCancel?: () => void;
  /** Texto del botón de confirmar (por defecto "Confirmar marcaje"). */
  confirmLabel?: string;
  /** Si true (enrolamiento), exige detectar un rostro antes de continuar. */
  requireDescriptor?: boolean;
}

export function SelfieCapture({ onCapture, onCancel, confirmLabel, requireDescriptor }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Precargar los modelos de reconocimiento facial (CDN) mientras el usuario se acomoda.
    loadFaceModels();
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user", width: 640, height: 480 }, audio: false })
      .then((s) => {
        if (!active) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play().catch(() => {});
        }
      })
      .catch(() => setError("No se pudo acceder a la cámara. Verifica los permisos."));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  const snap = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    // Selfies livianas: reducir el lado mayor a 512 px y comprimir a JPEG ~0.62.
    // Es suficiente para el reconocimiento facial (face-api) y reduce el peso de
    // ~100 KB a ~30 KB → mucho más almacenamiento por mes.
    const MAX = 512;
    const scale = Math.min(1, MAX / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror to match preview
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.62);
    setFaceError(null);
    setPreview(url);
  };

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

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div className="relative w-full max-w-md aspect-[4/3] overflow-hidden rounded-2xl border-2 border-border bg-black shadow-[var(--shadow-soft)]">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6 text-destructive-foreground bg-destructive/80">
            {error}
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
      </div>
      <canvas ref={canvasRef} className="hidden" />

      {faceError && (
        <p className="text-sm text-destructive text-center -mt-1">{faceError}</p>
      )}

      <div className="flex gap-3 w-full max-w-md">
        {preview ? (
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
        ) : (
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
