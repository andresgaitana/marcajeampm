import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock, LogIn, LogOut, ShieldCheck, UserCircle2, Loader2, CheckCircle2, Store, Settings2, Fingerprint, KeyRound, Lock, MapPin, MapPinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PinPad } from "@/components/PinPad";
import { SelfieCapture } from "@/components/SelfieCapture";
import { lookupEmployee, markAttendance, validateTerminal } from "@/lib/attendance.functions";
import { beginWebauthnAuth } from "@/lib/webauthn.functions";
import { useTerminalStore } from "@/hooks/useTerminalStore";
import { startAuthentication } from "@simplewebauthn/browser";
import { toast } from "sonner";
import logoAmpm from "@/assets/logo-ampm.png";

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

type Step = "type" | "code" | "cover" | "method" | "pin" | "password" | "webauthn" | "area" | "selfie" | "confirming" | "override" | "newpin" | "guarda" | "done";
type AttType = "entrada" | "salida";
type AuthMethod = "pin" | "password" | "webauthn";
type GeoState = { lat: number; lng: number; accuracy: number } | null;
type MarkInput = {
  employeeCode: string;
  type: AttType;
  selfieDataUrl: string;
  storeCode: string;
  terminalPin: string;
  pin?: string;
  newPin?: string;
  password?: string;
  webauthnResponse?: unknown;
  latitude?: number;
  longitude?: number;
  locationAccuracyM?: number;
  faceDescriptor?: number[];
  supervisorCode?: string;
  supervisorPin?: string;
  guardName?: string;
  guardCompany?: string;
  area?: "productos" | "mbk";
  cobertura?: boolean;
};

function MarcajePage() {
  const lookup = useServerFn(lookupEmployee);
  const mark = useServerFn(markAttendance);
  const beginAuth = useServerFn(beginWebauthnAuth);
  const { store: terminal, ready, save, clear } = useTerminalStore();

  const [step, setStep] = useState<Step>("type");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [type, setType] = useState<AttType | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [methods, setMethods] = useState<AuthMethod[]>([]);
  const [method, setMethod] = useState<AuthMethod | null>(null);
  const [webauthnResponse, setWebauthnResponse] = useState<unknown | null>(null);
  const [result, setResult] = useState<{ name: string; role: string; store: string | null; type: AttType; timestamp: string } | null>(null);
  const [now, setNow] = useState(new Date());
  const [loading, setLoading] = useState(false);
  const [geo, setGeo] = useState<GeoState>(null);
  const [geoDenied, setGeoDenied] = useState(false); // solo PERMISSION_DENIED (código 1)
  const [geoError, setGeoError] = useState(false);   // timeout / posición no disponible (reintenta)
  const [overrideCode, setOverrideCode] = useState("");
  const [overridePin, setOverridePin] = useState("");
  const [overrideMsg, setOverrideMsg] = useState("");
  const [pendingPayload, setPendingPayload] = useState<MarkInput | null>(null);
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [newPinMsg, setNewPinMsg] = useState("");
  const [isGuard, setIsGuard] = useState(false);
  const [guardName, setGuardName] = useState("");
  const [guardCompany, setGuardCompany] = useState("");
  // Caso 1 (cobertura): el colaborador es de otra tienda y presta apoyo aquí.
  const [cobertura, setCobertura] = useState(false);
  // Caso 2 (polivalente): cajero que apoya en la otra área; se le pregunta el área al entrar.
  const [isPolivalente, setIsPolivalente] = useState(false);
  const [area, setArea] = useState<"productos" | "mbk" | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Capture geolocation on mount (and refresh every 60s).
  // Intenta alta precisión (GPS); si expira o no hay señal —común bajo techo— reintenta
  // con baja precisión (wifi/red). Solo el código 1 (PERMISSION_DENIED) es "sin permiso":
  // un timeout NO significa que falte el permiso.
  useEffect(() => {
    if (!terminal || typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    const onOk = (pos: GeolocationPosition) => {
      if (cancelled) return;
      setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      setGeoDenied(false); setGeoError(false);
    };
    const tryGet = (highAccuracy: boolean) => {
      navigator.geolocation.getCurrentPosition(
        onOk,
        (err) => {
          if (cancelled) return;
          if (err.code === err.PERMISSION_DENIED) { setGeoDenied(true); setGeoError(false); return; }
          setGeoDenied(false);
          if (highAccuracy) tryGet(false);   // reintenta con baja precisión (wifi/red)
          else setGeoError(true);            // error temporal; el intervalo seguirá reintentando
        },
        highAccuracy
          ? { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
          : { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
      );
    };
    const get = () => tryGet(true);
    get();
    const t = setInterval(get, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, [terminal]);

  const reset = () => {
    setStep("type");
    setCode("");
    setPin("");
    setPassword("");
    setType(null);
    setEmployeeName(null);
    setMethods([]);
    setMethod(null);
    setWebauthnResponse(null);
    setResult(null);
    setOverrideCode("");
    setOverridePin("");
    setOverrideMsg("");
    setPendingPayload(null);
    setNewPin("");
    setNewPin2("");
    setNewPinMsg("");
    setIsGuard(false);
    setGuardName("");
    setGuardCompany("");
    setCobertura(false);
    setIsPolivalente(false);
    setArea(null);
  };

  // Paso siguiente tras autenticarse: guarda tercerizado → sus datos; polivalente
  // que ENTRA → escoger área; en cualquier otro caso, directo a la selfie.
  const nextAfterAuth = (): Step =>
    isGuard ? "guarda" : isPolivalente && type === "entrada" ? "area" : "selfie";

  const submitCode = async (cover = false) => {
    if (!code || !type || !terminal) return;
    setLoading(true);
    try {
      const res = await lookup({ data: { employeeCode: code, storeCode: terminal.code, cover } });
      if (!res.found) {
        // El colaborador existe pero es de otra tienda: ofrecer marcar como cobertura
        // (Autoservicio, sin aprobación del GT). Si ya venimos de cobertura, es error real.
        if ("wrongStore" in res && res.wrongStore && !cover) {
          setStep("cover");
          return;
        }
        toast.error(
          "wrongStore" in res && res.wrongStore
            ? `Este colaborador no pertenece a ${terminal.name}`
            : "Código no encontrado o colaborador inactivo",
        );
        setCode("");
        return;
      }
      setEmployeeName(res.full_name);
      setIsGuard(res.role === "seguridad_tercerizada");
      setCobertura(!!res.fromOtherStore);
      setIsPolivalente(!!res.polivalente);
      const m: AuthMethod[] = [];
      if (res.hasWebauthn) m.push("webauthn");
      if (res.hasPassword) m.push("password");
      if (res.hasPin) m.push("pin");
      if (m.length === 0) {
        toast.error("Este colaborador no tiene método de autenticación configurado");
        return;
      }
      setMethods(m);
      if (m.length === 1) {
        setMethod(m[0]);
        if (m[0] === "webauthn") void startWebauthn();
        else setStep(m[0]);
      } else {
        setStep("method");
      }
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

  const chooseMethod = (m: AuthMethod) => {
    setMethod(m);
    if (m === "webauthn") void startWebauthn();
    else setStep(m);
  };

  const startWebauthn = async () => {
    if (!terminal) return;
    setStep("webauthn");
    try {
      const res = await beginAuth({ data: { employeeCode: code, storeCode: terminal.code } });
      if (!res.ok) {
        toast.error(res.error);
        setStep("method");
        return;
      }
      const assertion = await startAuthentication({ optionsJSON: res.options });
      setWebauthnResponse(assertion);
      setStep(nextAfterAuth());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancelado o no soportado");
      setStep(methods.length > 1 ? "method" : "code");
    }
  };

  const submitPin = () => {
    if (pin.length < 4) {
      toast.error("El PIN debe tener al menos 4 dígitos");
      return;
    }
    setStep(nextAfterAuth());
  };

  const submitPassword = () => {
    if (password.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres");
      return;
    }
    setStep(nextAfterAuth());
  };

  const submit = async (payload: MarkInput) => {
    setStep("confirming");
    try {
      const res = await mark({ data: payload });
      if (!res.ok) {
        // PIN restablecido: pedir nuevo PIN sin perder la selfie ya capturada.
        if ("mustChangePin" in res && res.mustChangePin) {
          setPendingPayload({ ...payload, newPin: undefined });
          setNewPinMsg(res.error ?? "Crea un nuevo PIN para continuar.");
          setStep("newpin");
          return;
        }
        const faceFail = !!res.error && res.error.includes("rostro no coincide");
        const supFail = !!res.error && res.error.includes("Supervisor");
        const locFail = "needsSupervisor" in res && res.needsSupervisor === true; // ubicación no válida → autorizable
        if (faceFail || supFail || locFail) {
          // Ofrecer (o reintentar) el override de supervisor sin perder la selfie/ubicación.
          if (faceFail || locFail) setPendingPayload({ ...payload, supervisorCode: undefined, supervisorPin: undefined });
          setOverrideMsg(res.error ?? "Se requiere autorización de un supervisor.");
          if (supFail) toast.error(res.error);
          setStep("override");
          return;
        }
        toast.error(res.error);
        setPin("");
        setPassword("");
        setWebauthnResponse(null);
        setStep(method ?? "method");
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
      setStep(method ?? "method");
    }
  };

  const onSelfie = async (dataUrl: string, faceDescriptor: number[] | null) => {
    if (!type || !terminal) return;
    const payload: MarkInput = {
      employeeCode: code,
      type,
      selfieDataUrl: dataUrl,
      storeCode: terminal.code,
      terminalPin: terminal.pin,
    };
    if (faceDescriptor) payload.faceDescriptor = faceDescriptor;
    if (method === "pin") payload.pin = pin;
    else if (method === "password") payload.password = password;
    else if (method === "webauthn") payload.webauthnResponse = webauthnResponse;
    if (isGuard && guardName.trim()) {
      payload.guardName = guardName.trim();
      if (guardCompany.trim()) payload.guardCompany = guardCompany.trim();
    }
    if (cobertura) payload.cobertura = true;
    if (area) payload.area = area;
    if (geo) {
      payload.latitude = geo.lat;
      payload.longitude = geo.lng;
      payload.locationAccuracyM = geo.accuracy;
    }
    await submit(payload);
  };

  const submitOverride = async () => {
    if (!pendingPayload) return;
    if (!overrideCode || overridePin.length < 4) {
      toast.error("Ingresa el código y PIN del supervisor");
      return;
    }
    await submit({ ...pendingPayload, supervisorCode: overrideCode, supervisorPin: overridePin });
  };

  const submitNewPin = async () => {
    if (!pendingPayload) return;
    if (newPin.length < 4) {
      toast.error("El nuevo PIN debe tener al menos 4 dígitos");
      return;
    }
    if (newPin === "1234") {
      toast.error("Elige un PIN distinto de 1234");
      return;
    }
    if (newPin !== newPin2) {
      toast.error("Los PIN no coinciden");
      return;
    }
    await submit({ ...pendingPayload, newPin });
  };

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
          <img src={logoAmpm} alt="AM/PM Centroamérica" className="h-10 w-auto shrink-0" />
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

      {/* GPS status banner */}
      <div className={`px-4 py-1.5 text-xs flex items-center justify-center gap-1.5 ${geo ? "bg-success/10 text-success" : "bg-amber-500/10 text-amber-700"}`}>
        {geo ? (
          <><MapPin className="h-3 w-3" /> Ubicación detectada (±{Math.round(geo.accuracy)}m)</>
        ) : geoDenied ? (
          <><MapPinOff className="h-3 w-3" /> Sin permiso de ubicación — actívalo para poder marcar.</>
        ) : geoError ? (
          <><MapPin className="h-3 w-3 animate-pulse" /> No se obtiene la ubicación — reintentando (acércate a una ventana o entrada).</>
        ) : (
          <><MapPin className="h-3 w-3 animate-pulse" /> Detectando ubicación…</>
        )}
      </div>

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
              <Input
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoFocus
                className="h-14 text-lg text-center font-mono uppercase tracking-[0.3em]"
                placeholder="Ej. GT-A91"
                value={code}
                maxLength={16}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                onKeyDown={(e) => { if (e.key === "Enter") void submitCode(); }}
              />
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>
                  Atrás
                </Button>
                <Button
                  className="flex-[2] h-14 text-base bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={!code || loading}
                  onClick={() => submitCode()}
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Continuar"}
                </Button>
              </div>
            </>
          )}

          {step === "cover" && (
            <>
              <div className="text-center mb-6">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-3">
                  <Store className="h-8 w-8 text-accent" />
                </div>
                <h2 className="text-xl font-bold text-foreground">¿Estás cubriendo un turno?</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  El código <span className="font-mono font-semibold text-foreground">{code}</span> no pertenece a {terminal.name}.
                  Si vienes a cubrir un turno aquí, continúa: tu marcaje quedará registrado como
                  <span className="font-semibold text-foreground"> cobertura</span> y tu tienda de origen lo verá en su reporte.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <Button
                  className="h-14 bg-accent text-accent-foreground hover:bg-accent/90"
                  disabled={loading}
                  onClick={() => submitCode(true)}
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Sí, estoy cubriendo turno"}
                </Button>
                <Button variant="outline" className="h-12" onClick={() => { setStep("code"); setCode(""); }}>
                  Corregir código
                </Button>
              </div>
            </>
          )}

          {step === "method" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">{employeeName}</p>
                <h2 className="text-xl font-bold text-foreground mt-1">¿Cómo quieres autenticarte?</h2>
              </div>
              <div className="space-y-3">
                {methods.includes("webauthn") && (
                  <button onClick={() => chooseMethod("webauthn")} className="w-full h-20 rounded-2xl bg-primary text-primary-foreground flex items-center gap-4 px-5 active:scale-95 transition-transform">
                    <Fingerprint className="h-9 w-9" />
                    <div className="text-left">
                      <div className="font-bold text-lg">Huella</div>
                      <div className="text-xs opacity-80">Más rápido y seguro</div>
                    </div>
                  </button>
                )}
                {methods.includes("password") && (
                  <button onClick={() => chooseMethod("password")} className="w-full h-20 rounded-2xl bg-secondary text-foreground border border-border flex items-center gap-4 px-5 active:scale-95 transition-transform">
                    <Lock className="h-8 w-8" />
                    <div className="text-left">
                      <div className="font-bold text-lg">Contraseña</div>
                      <div className="text-xs text-muted-foreground">Usuario y contraseña</div>
                    </div>
                  </button>
                )}
                {methods.includes("pin") && (
                  <button onClick={() => chooseMethod("pin")} className="w-full h-20 rounded-2xl bg-secondary text-foreground border border-border flex items-center gap-4 px-5 active:scale-95 transition-transform">
                    <KeyRound className="h-8 w-8" />
                    <div className="text-left">
                      <div className="font-bold text-lg">PIN</div>
                      <div className="text-xs text-muted-foreground">4-8 dígitos</div>
                    </div>
                  </button>
                )}
              </div>
              <Button variant="outline" className="w-full mt-4 h-12" onClick={reset}>Cancelar</Button>
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

          {step === "password" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">{employeeName}</p>
                <h2 className="text-xl font-bold text-foreground mt-1">Tu contraseña</h2>
              </div>
              <Input
                type="password"
                autoFocus
                className="h-14 text-lg"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }}
                placeholder="••••••••"
              />
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={() => setStep(methods.length > 1 ? "method" : "code")}>Atrás</Button>
                <Button
                  className={`flex-1 h-14 text-white ${type === "entrada" ? "bg-success hover:bg-success/90" : "bg-accent hover:bg-accent/90"}`}
                  disabled={password.length < 6}
                  onClick={submitPassword}
                >
                  Continuar
                </Button>
              </div>
            </>
          )}

          {step === "webauthn" && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Fingerprint className="h-20 w-20 text-primary animate-pulse" />
              <p className="text-foreground font-medium">Coloca tu huella…</p>
              <p className="text-xs text-muted-foreground text-center">Sigue las instrucciones del dispositivo</p>
              <Button variant="outline" onClick={() => setStep(methods.length > 1 ? "method" : "code")}>Cancelar</Button>
            </div>
          )}

          {step === "guarda" && (
            <>
              <div className="text-center mb-4">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-purple-500/15 flex items-center justify-center mb-3">
                  <ShieldCheck className="h-8 w-8 text-purple-600" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Datos del guarda</h2>
                <p className="text-sm text-muted-foreground mt-1">Seguridad tercerizada — registra quién marca</p>
              </div>
              <div className="space-y-3">
                <Input
                  autoFocus
                  className="h-14 text-lg"
                  value={guardName}
                  onChange={(e) => setGuardName(e.target.value)}
                  placeholder="Nombre del guarda"
                  maxLength={120}
                />
                <Input
                  className="h-14 text-lg"
                  value={guardCompany}
                  onChange={(e) => setGuardCompany(e.target.value)}
                  placeholder="Empresa de seguridad"
                  maxLength={120}
                  onKeyDown={(e) => { if (e.key === "Enter" && guardName.trim()) setStep("selfie"); }}
                />
              </div>
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>Cancelar</Button>
                <Button
                  className="flex-1 h-14 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={!guardName.trim()}
                  onClick={() => setStep("selfie")}
                >
                  Continuar
                </Button>
              </div>
            </>
          )}

          {step === "area" && (
            <>
              <div className="text-center mb-6">
                <p className="text-sm text-muted-foreground">{employeeName}</p>
                <h2 className="text-xl font-bold text-foreground mt-1">¿En qué área entras hoy?</h2>
                <p className="text-sm text-muted-foreground mt-1">Selecciona dónde cubrirás el turno</p>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={() => { setArea("productos"); setStep("selfie"); }}
                  className="h-24 rounded-2xl bg-primary text-primary-foreground flex flex-col items-center justify-center gap-1 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <span className="text-2xl font-bold tracking-wide">Productos</span>
                  <span className="text-xs opacity-80">Caja y tienda</span>
                </button>
                <button
                  onClick={() => { setArea("mbk"); setStep("selfie"); }}
                  className="h-24 rounded-2xl bg-accent text-accent-foreground flex flex-col items-center justify-center gap-1 shadow-[var(--shadow-soft)] active:scale-95 transition-transform"
                >
                  <span className="text-2xl font-bold tracking-wide">MBK</span>
                  <span className="text-xs opacity-80">Panadería</span>
                </button>
              </div>
              <Button variant="outline" className="w-full mt-4 h-12" onClick={reset}>Cancelar</Button>
            </>
          )}

          {step === "selfie" && (
            <>
              <div className="text-center mb-4">
                <h2 className="text-xl font-bold text-foreground">Toma tu selfie</h2>
                <p className="text-sm text-muted-foreground">Mira a la cámara y parpadea cuando se te indique</p>
                {cobertura && (
                  <p className="text-xs font-semibold text-accent mt-1">Marcaje de cobertura en {terminal.name}</p>
                )}
                {area && (
                  <p className="text-xs font-semibold text-primary mt-1">
                    Turno en {area === "productos" ? "Productos" : "MBK"}
                  </p>
                )}
              </div>
              <SelfieCapture
                requireLiveness
                onCapture={onSelfie}
                onCancel={() => setStep(isGuard ? "guarda" : isPolivalente && type === "entrada" ? "area" : "pin")}
              />
            </>
          )}

          {step === "confirming" && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Loader2 className="h-12 w-12 animate-spin text-accent" />
              <p className="text-muted-foreground">Registrando marcaje…</p>
            </div>
          )}

          {step === "override" && (
            <>
              <div className="text-center mb-4">
                <h2 className="text-xl font-bold text-foreground">Autorización de supervisor</h2>
                <p className="text-sm text-destructive mt-1">{overrideMsg}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Si el rostro no coincide o no se logra la ubicación, un Gerente de Tienda o de Zona
                  puede autorizar este marcaje con su código y PIN (queda registrado quién autorizó).
                </p>
              </div>
              <div className="space-y-3">
                <Input
                  autoFocus
                  className="h-14 text-lg"
                  value={overrideCode}
                  onChange={(e) => setOverrideCode(e.target.value)}
                  placeholder="Código del supervisor (ej. GT-A07)"
                />
                <Input
                  type="password"
                  inputMode="numeric"
                  className="h-14 text-lg"
                  value={overridePin}
                  onChange={(e) => setOverridePin(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitOverride(); }}
                  placeholder="PIN del supervisor"
                  maxLength={8}
                />
              </div>
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>Cancelar</Button>
                <Button
                  className="flex-1 h-14 bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={submitOverride}
                >
                  Autorizar marcaje
                </Button>
              </div>
            </>
          )}

          {step === "newpin" && (
            <>
              <div className="text-center mb-4">
                <div className="mx-auto h-14 w-14 rounded-2xl bg-amber-500/15 flex items-center justify-center mb-3">
                  <KeyRound className="h-8 w-8 text-amber-600" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Crea tu nuevo PIN</h2>
                <p className="text-sm text-muted-foreground mt-1">{newPinMsg}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Por seguridad, define un PIN propio de 4 a 8 dígitos (distinto de 1234).
                </p>
              </div>
              <div className="space-y-3">
                <Input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  className="h-14 text-lg text-center font-mono tracking-[0.3em]"
                  value={newPin}
                  maxLength={8}
                  placeholder="Nuevo PIN"
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                />
                <Input
                  type="password"
                  inputMode="numeric"
                  className="h-14 text-lg text-center font-mono tracking-[0.3em]"
                  value={newPin2}
                  maxLength={8}
                  placeholder="Confirmar PIN"
                  onChange={(e) => setNewPin2(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitNewPin(); }}
                />
              </div>
              <div className="flex gap-3 mt-6">
                <Button variant="outline" className="flex-1 h-14" onClick={reset}>Cancelar</Button>
                <Button
                  className="flex-1 h-14 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={newPin.length < 4 || newPin2.length < 4}
                  onClick={submitNewPin}
                >
                  Guardar y marcar
                </Button>
              </div>
            </>
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
