import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, LogIn, LogOut, ShieldCheck, UserCircle2, Loader2, CheckCircle2, Store, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PinPad } from "@/components/PinPad";
import { SelfieCapture } from "@/components/SelfieCapture";
import { lookupEmployee, markAttendance, validateTerminal } from "@/lib/attendance.functions";
import { useTerminalStore } from "@/hooks/useTerminalStore";
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
  const { store: terminal, ready, save, clear } = useTerminalStore();

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
    setStep("type");
    setCode("");
    setPin("");
    setType(null);
    setEmployeeName(null);
    setResult(null);
  };

  const submitCode = async () => {
    if (!code || !type || !terminal) return;
    setLoading(true);
    try {
      const res = await lookup({ data: { employeeCode: code, storeCode: terminal.code } });
      if (!res.found) {
        toast.error(
          "wrongStore" in res && res.wrongStore
            ? `Este colaborador no pertenece a ${terminal.name}`
            : "Código no encontrado o colaborador inactivo",
        );
        setCode("");
        return;
      }
      setEmployeeName(res.full_name);
      setStep("pin");
    } catch {
      toast.error("Error al validar el código");
    } finally {
      setLoading(false);
    }
  };

  const chooseType = (t: AttType) => {
    setType(t);
    setStep("code");
  };

  const submitPin = () => {
    if (pin.length < 4) {
      toast.error("El PIN debe tener al menos 4 dígitos");
      return;
    }
    setStep("selfie");
  };

  const onSelfie = async (dataUrl: string) => {
    if (!type || !terminal) return;
    setStep("confirming");
    try {
      const res = await mark({
        data: {
          employeeCode: code,
          pin,
          type,
          selfieDataUrl: dataUrl,
          storeCode: terminal.code,
          terminalPin: terminal.pin,
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

  // Set initial step when terminal is ready
  useEffect(() => {
    if (ready && terminal && step === "code" && !type) setStep("type");
  }, [ready, terminal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!terminal) {
    return <TerminalSetup onDone={save} />;
  }

  const typeColorClass = type === "entrada" ? "bg-success" : "bg-accent";
  const typeLabel = type === "entrada" ? "ENTRADA" : "SALIDA";

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary to-background flex flex-col">
      <header className="flex items-center justify-between p-4 md:px-8 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-[var(--gradient-brand)] flex items-center justify-center shadow-[var(--shadow-soft)] shrink-0">
            <Store className="h-6 w-6 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight text-foreground leading-tight truncate">
              {terminal.name}
            </h1>
            <p className="text-xs text-muted-foreground font-mono">Tienda {terminal.code}</p>
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
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              if (confirm("¿Desvincular esta tienda de la terminal?")) clear();
            }}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
          <Link to="/admin">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-primary">
              <ShieldCheck className="h-4 w-4 mr-1" />
              Admin
            </Button>
          </Link>
        </div>
      </header>

      {type && step !== "done" && (
        <div className={`${typeColorClass} text-white py-3 px-4 text-center font-bold text-lg tracking-wider shadow-md`}>
          MARCANDO {typeLabel}
        </div>
      )}

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-card rounded-3xl shadow-[var(--shadow-soft)] border border-border p-6 md:p-8">
          {step === "type" && (
            <>
              <div className="text-center mb-6">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-[var(--gradient-brand)] flex items-center justify-center mb-3">
                  <Clock className="h-8 w-8 text-primary-foreground" />
                </div>
                <h2 className="text-xl font-bold text-foreground">¿Qué deseas marcar?</h2>
                <p className="text-sm text-muted-foreground mt-1">Selecciona el tipo</p>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <button
                  onClick={() => chooseType("entrada")}
                  className="group h-40 rounded-2xl bg-success text-white flex flex-col items-center justify-center gap-3 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <LogIn className="h-14 w-14" />
                  <span className="text-2xl font-bold tracking-wider">ENTRADA</span>
                  <span className="text-xs opacity-80">Llegada al turno</span>
                </button>
                <button
                  onClick={() => chooseType("salida")}
                  className="group h-40 rounded-2xl bg-accent text-white flex flex-col items-center justify-center gap-3 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <LogOut className="h-14 w-14" />
                  <span className="text-2xl font-bold tracking-wider">SALIDA</span>
                  <span className="text-xs opacity-80">Fin del turno</span>
                </button>
              </div>
            </>
          )}

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
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>
                  Atrás
                </Button>
                <Button
                  className="flex-[2] h-14 text-base bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={!code || loading}
                  onClick={submitCode}
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Continuar"}
                </Button>
              </div>
            </>
          )}

          {step === "pin" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">{employeeName}</p>
                <h2 className="text-xl font-bold text-foreground mt-1">Ingresa tu PIN</h2>
              </div>
              <PinPad value={pin} onChange={setPin} maxLength={8} mask />
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>
                  Cancelar
                </Button>
                <Button
                  className={`flex-1 h-14 text-white ${type === "entrada" ? "bg-success hover:bg-success/90" : "bg-accent hover:bg-accent/90"}`}
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
              <div className={`mx-auto h-24 w-24 rounded-full ${result.type === "entrada" ? "bg-success" : "bg-accent"} flex items-center justify-center mb-4`}>
                <CheckCircle2 className="h-14 w-14 text-white" />
              </div>
              <div className={`text-3xl font-extrabold tracking-wider ${result.type === "entrada" ? "text-success" : "text-accent"}`}>
                {result.type === "entrada" ? "ENTRADA REGISTRADA" : "SALIDA REGISTRADA"}
              </div>
              <p className="text-muted-foreground mt-1">{result.name}</p>
              <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-mono font-semibold text-foreground">
                  {new Date(result.timestamp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-sm text-muted-foreground">· {result.store}</span>
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

function TerminalSetup({ onDone }: { onDone: (info: { id: string; code: string; name: string; pin: string }) => void }) {
  const validate = useServerFn(validateTerminal);
  const [storeCode, setStoreCode] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await validate({ data: { storeCode: storeCode.trim().toUpperCase(), terminalPin: pin.trim() } });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onDone({ ...res.store, pin: pin.trim() });
      toast.success(`Terminal vinculada a ${res.store.name}`);
    } catch {
      toast.error("Error al validar terminal");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary to-background flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-card rounded-3xl shadow-[var(--shadow-soft)] border border-border p-8 space-y-5">
        <div className="text-center">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-[var(--gradient-brand)] flex items-center justify-center mb-3">
            <Store className="h-8 w-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Configurar terminal</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vincula este dispositivo a una tienda. Solo se hace una vez.
          </p>
        </div>
        <div>
          <Label htmlFor="storeCode">Código de tienda</Label>
          <Input
            id="storeCode"
            required
            className="h-12 mt-1 font-mono uppercase tracking-wider"
            placeholder="Ej. T001"
            value={storeCode}
            onChange={(e) => setStoreCode(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <Label htmlFor="pin">PIN de terminal</Label>
          <Input
            id="pin"
            type="password"
            inputMode="numeric"
            required
            minLength={4}
            maxLength={8}
            className="h-12 mt-1 font-mono"
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Pídelo al administrador de tu tienda.
          </p>
        </div>
        <Button
          type="submit"
          className="w-full h-12 bg-accent text-accent-foreground hover:bg-accent/90"
          disabled={loading}
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Vincular terminal"}
        </Button>
        <div className="text-center">
          <Link to="/admin" className="text-xs text-muted-foreground hover:text-primary">
            Soy administrador →
          </Link>
        </div>
      </form>
    </div>
  );
}
