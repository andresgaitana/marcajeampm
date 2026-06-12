import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { claimFirstAdmin, checkAdmin } from "@/lib/admin.functions";
import logoAmpm from "@/assets/logo-ampm.png.asset.json";

export const Route = createFileRoute("/admin/login")({
  head: () => ({ meta: [{ title: "Admin · Iniciar sesión" }] }),
  component: AdminLogin,
});

function AdminLogin() {
  const nav = useNavigate();
  const claim = useServerFn(claimFirstAdmin);
  const check = useServerFn(checkAdmin);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
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
        // Try to claim first admin (only succeeds if no admin exists yet)
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
        // If no admin exists yet, claim it
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-secondary to-background p-4">
      <div className="w-full max-w-md bg-card rounded-3xl shadow-[var(--shadow-soft)] border border-border p-8">
        <div className="text-center mb-6">
          <img src={logoAmpm.url} alt="AM/PM Centroamérica" className="mx-auto h-16 w-auto mb-3" />
          <h1 className="text-2xl font-bold text-foreground">Panel de Administración</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === "login" ? "Inicia sesión para continuar" : "Crea tu cuenta de administrador"}
          </p>
        </div>

        <form onSubmit={handle} className="space-y-4">
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
          <div>
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="h-12 mt-1"
            />
          </div>
          <Button
            type="submit"
            className="w-full h-12 bg-accent text-accent-foreground hover:bg-accent/90"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : mode === "login" ? "Entrar" : "Crear cuenta"}
          </Button>
        </form>

        <button
          type="button"
          className="w-full mt-4 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "¿No tienes cuenta? Crear cuenta de administrador" : "¿Ya tienes cuenta? Iniciar sesión"}
        </button>

        <p className="text-xs text-center text-muted-foreground mt-6">
          La primera cuenta creada se vuelve administrador automáticamente.
        </p>
      </div>
    </div>
  );
}