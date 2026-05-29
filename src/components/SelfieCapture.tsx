import { useEffect, useRef, useState } from "react";
import { Camera, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  onCapture: (dataUrl: string) => void;
  onCancel?: () => void;
}

export function SelfieCapture({ onCapture, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
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
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror to match preview
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.8);
    setPreview(url);
  };

  const retake = () => setPreview(null);

  const confirm = () => {
    if (preview) onCapture(preview);
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

      <div className="flex gap-3 w-full max-w-md">
        {preview ? (
          <>
            <Button type="button" variant="outline" className="flex-1 h-14" onClick={retake}>
              <RotateCcw className="mr-2 h-5 w-5" />
              Repetir
            </Button>
            <Button
              type="button"
              className="flex-1 h-14 bg-accent text-accent-foreground hover:bg-accent/90"
              onClick={confirm}
            >
              Confirmar marcaje
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