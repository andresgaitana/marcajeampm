import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { claimFirstAdmin, checkAdmin } from "@/lib/admin.functions";
import logoAmpm from "@/assets/logo-ampm.png";

export const Route = createFileRoute("/admin/login")({
  head: () => ({ meta: [{ title: "Admin · Iniciar sesión" }] }),
  component: AdminLogin,
});

function AdminLogin() {
  const nav = useNavigate();
  const claim = useServerFn(claimFirstAdmin);
  const check = useServerFn(checkAdmin);
  const [mode, setMode] = useState<"login" | "signup" | "recovery">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Si el usuario llega desde el enlace de "restablecer contraseña" del correo,
  // Supabase emite el evento PASSWORD_RECOVERY: mostramos el formulario para fijar
  // una nueva contraseña.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("recovery");
        setPassword("");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success("Contraseña actualizada. Inicia sesión con tu nueva contraseña.");
        await supabase.auth.signOut();
        setMode("login");
        setPassword("");
        return;
      }
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/admin` },
        });
        if (error) {
          toast.error(error.message);
          return;
        }
        try {
          const r = await claim();
          if (r.claimed) {
            toast.success("Cuenta de administrador creada");
          } else {
            toast.success("Cuenta creada. Pide a un admin que te asigne el rol.");
          }
        } catch {
          /* not signed in yet if email confirm required */
        }
        nav({ to: "/admin" });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          toast.error(error.message);
          return;
        }
        const status = await check();
        if (!status.isAdmin) {
          try {
            const r = await claim();
            if (r.claimed) toast.success("Eres el primer administrador");
          } catch {
            /* ignore */
          }
        }
        nav({ to: "/admin" });
      }
    } finally {
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    if (!email) {
      toast.error("Escribe tu correo arriba y vuelve a tocar '¿Olvidaste tu contraseña?'");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/admin/login`,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Te enviamos un correo para restablecer tu contraseña. Revisa tu bandeja (y spam).");
    } finally {
      setLoading(false);
    }
  };

  const title =
    mode === "recovery" ? "Nueva contraseña" : mode === "signup" ? "Crea tu cuenta de administrador" : "Inicia sesión para continuar";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary to-background p-4">
      <div className="w-full max-w-md bg-card rounded-3xl shadow-[var(--shadow-soft)] border border-border p-8">
        <div className="text-center mb-6">
          <img src={logoAmpm} alt="AM/PM Centroamérica" className="mx-auto h-16 w-auto mb-3" />
          <h1 className="text-2xl font-bold text-foreground">Panel de Administración</h1>
          <p className="text-sm text-muted-foreground mt-1">{title}</p>
        </div>

        <form onSubmit={handle} className="space-y-4">
          {mode !== "recovery" && (
            <div>
              <Label htmlFor="email">Correo</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="h-12 mt-1"
              />
            </div>
          )}
          <div>
            <Label htmlFor="password">{mode === "recovery" ? "Nueva contraseña" : "Contraseña"}</Label>
            <div className="relative mt-1">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className="h-12 pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Ocultar contraseña" : "Ver contraseña"}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {mode === "login" && (
            <button
              type="button"
              onClick={forgotPassword}
              className="block w-full text-right text-sm text-accent hover:underline"
            >
              ¿Olvidaste tu contraseña?
            </button>
          )}

          <Button
            type="submit"
            className="w-full h-12 bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : mode === "recovery" ? (
              "Guardar contraseña"
            ) : mode === "login" ? (
              "Entrar"
            ) : (
              "Crear cuenta"
            )}
          </Button>
        </form>

        {mode !== "recovery" && (
          <button
            type="button"
            className="w-full mt-4 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? "¿No tienes cuenta? Crear cuenta de administrador" : "¿Ya tienes cuenta? Iniciar sesión"}
          </button>
        )}

        <p className="text-xs text-center text-muted-foreground mt-6">
          La primera cuenta creada se vuelve administrador automáticamente.
        </p>
      </div>
    </div>
  );
}
