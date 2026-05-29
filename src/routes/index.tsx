import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, LogIn, LogOut, ShieldCheck, UserCircle2, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PinPad } from "@/components/PinPad";
import { SelfieCapture } from "@/components/SelfieCapture";
import { lookupEmployee, markAttendance } from "@/lib/attendance.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Marcaje | Control de Asistencia" },
      { name: "description", content: "Registro de entrada y salida para cajeros, gerentes y seguridad mediante PIN y selfie." },
      { property: "og:title", content: "Marcaje | Control de Asistencia" },
      { property: "og:description", content: "Registra tu entrada o salida en segundos." },
    ],
  }),
  component: MarcajePage,
});

type Step = "code" | "type" | "pin" | "selfie" | "confirming" | "done";
type AttType = "entrada" | "salida";

function MarcajePage() {
  const lookup = useServerFn(lookupEmployee);
  const mark = useServerFn(markAttendance);

  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [type, setType] = useState<AttType | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; role: string; store: string | null; type: AttType; timestamp: string } | null>(null);
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const reset = () => {
    setStep("code");
    setCode("");
    setPin("");
    setType(null);
    setEmployeeName(null);
    setResult(null);
  };

  const submitCode = async () => {
    if (!code) return;
    setLoading(true);
    try {
      const res = await lookup({ data: { employeeCode: code } });
      if (!res.found) {
        toast.error("Código no encontrado o colaborador inactivo");
        setCode("");
        return;
      }
      setEmployeeName(res.full_name);
      setStep("type");
    } catch {
      toast.error("Error al validar el código");
    } finally {
      setLoading(false);
    }
  };

  const chooseType = (t: AttType) => {
    setType(t);
    setStep("pin");
  };

  const submitPin = () => {
    if (pin.length < 4) {
      toast.error("El PIN debe tener al menos 4 dígitos");
      return;
    }
    setStep("selfie");
  };

  const onSelfie = async (dataUrl: string) => {
    if (!type) return;
    setStep("confirming");
    try {
      const res = await mark({
        data: {
          employeeCode: code,
          pin,
          type,
          selfieDataUrl: dataUrl,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
        setPin("");
        setStep("pin");
        return;
      }
      setResult({
        name: res.employee.full_name,
        role: res.employee.role,
        store: res.employee.store,
        type: res.type,
        timestamp: res.timestamp,
      });
      setStep("done");
      setTimeout(reset, 6000);
    } catch {
      toast.error("Error al registrar el marcaje");
      setStep("pin");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary to-background flex flex-col">
      <header className="flex items-center justify-between p-4 md:px-8">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-[var(--gradient-brand)] flex items-center justify-center shadow-[var(--shadow-soft)]">
            <Clock className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-foreground leading-tight">Control de Asistencia</h1>
            <p className="text-xs text-muted-foreground">Marcaje de entrada y salida</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <div className="text-2xl font-mono font-semibold text-primary">
              {now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
            <div className="text-xs text-muted-foreground capitalize">
              {now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}
            </div>
          </div>
          <Link to="/admin">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary">
              <ShieldCheck className="h-4 w-4 mr-1" />
              Admin
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-card rounded-3xl shadow-[var(--shadow-soft)] border border-border p-6 md:p-8">
          {step === "code" && (
            <>
              <div className="text-center mb-6">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-3">
                  <UserCircle2 className="h-8 w-8 text-accent" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Ingresa tu código</h2>
                <p className="text-sm text-muted-foreground mt-1">Código de colaborador</p>
              </div>
              <PinPad value={code} onChange={setCode} maxLength={8} />
              <Button
                className="w-full h-14 mt-6 text-base bg-primary text-primary-foreground hover:bg-primary/90"
                disabled={!code || loading}
                onClick={submitCode}
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Continuar"}
              </Button>
            </>
          )}

          {step === "type" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">Hola,</p>
                <h2 className="text-2xl font-bold text-foreground">{employeeName}</h2>
                <p className="text-sm text-muted-foreground mt-3">¿Qué deseas marcar?</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => chooseType("entrada")}
                  className="group h-36 rounded-2xl bg-[var(--gradient-brand)] text-primary-foreground flex flex-col items-center justify-center gap-2 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <LogIn className="h-10 w-10" />
                  <span className="text-lg font-semibold">Entrada</span>
                </button>
                <button
                  onClick={() => chooseType("salida")}
                  className="group h-36 rounded-2xl bg-[var(--gradient-accent)] text-accent-foreground flex flex-col items-center justify-center gap-2 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <LogOut className="h-10 w-10" />
                  <span className="text-lg font-semibold">Salida</span>
                </button>
              </div>
              <Button variant="ghost" className="w-full mt-4 text-muted-foreground" onClick={reset}>
                Cancelar
              </Button>
            </>
          )}

          {step === "pin" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">{employeeName}</p>
                <h2 className="text-xl font-bold text-foreground mt-1">
                  Ingresa tu PIN para registrar{" "}
                  <span className={type === "entrada" ? "text-primary" : "text-accent"}>
                    {type === "entrada" ? "entrada" : "salida"}
                  </span>
                </h2>
              </div>
              <PinPad value={pin} onChange={setPin} maxLength={8} mask />
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>
                  Cancelar
                </Button>
                <Button
                  className="flex-1 h-14 bg-accent text-accent-foreground hover:bg-accent/90"
                  disabled={pin.length < 4}
                  onClick={submitPin}
                >
                  Continuar
                </Button>
              </div>
            </>
          )}

          {step === "selfie" && (
            <>
              <div className="text-center mb-4">
                <h2 className="text-xl font-bold text-foreground">Toma tu selfie</h2>
                <p className="text-sm text-muted-foreground">Mira a la cámara y captura tu foto</p>
              </div>
              <SelfieCapture onCapture={onSelfie} onCancel={() => setStep("pin")} />
            </>
          )}

          {step === "confirming" && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="h-12 w-12 animate-spin text-accent" />
              <p className="text-muted-foreground">Registrando marcaje…</p>
            </div>
          )}

          {step === "done" && result && (
            <div className="text-center py-6">
              <div className="mx-auto h-20 w-20 rounded-full bg-[oklch(0.65_0.16_155)]/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-12 w-12 text-[oklch(0.55_0.16_155)]" />
              </div>
              <h2 className="text-2xl font-bold text-foreground">¡Marcaje exitoso!</h2>
              <p className="text-muted-foreground mt-1">{result.name}</p>
              <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary">
                {result.type === "entrada" ? (
                  <LogIn className="h-4 w-4 text-primary" />
                ) : (
                  <LogOut className="h-4 w-4 text-accent" />
                )}
                <span className="text-sm font-semibold capitalize text-foreground">{result.type}</span>
                <span className="text-sm text-muted-foreground">
                  · {new Date(result.timestamp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <Button className="w-full mt-6 h-12" variant="outline" onClick={reset}>
                Listo
              </Button>
            </div>
          )}
        </div>
      </main>

      <footer className="text-center p-4 text-xs text-muted-foreground">
        Sistema de Marcaje · {now.getFullYear()}
      </footer>
    </div>
  );
}
