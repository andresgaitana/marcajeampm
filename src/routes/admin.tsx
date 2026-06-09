import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { checkAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { LogOut, Loader2, Clock, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Panel de Administración" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const check = useServerFn(checkAdmin);
  const [state, setState] = useState<"loading" | "ready" | "denied">("loading");

  // Skip gating on the login page itself
  const isLogin = path === "/admin/login";

  useEffect(() => {
    if (isLogin) return;
    let mounted = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        nav({ to: "/admin/login" });
        return;
      }
      try {
        const r = await check();
        if (!mounted) return;
        setState(r.hasAccess ? "ready" : "denied");
      } catch {
        if (mounted) setState("denied");
      }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session && !isLogin) nav({ to: "/admin/login" });
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [isLogin, check, nav]);

  if (isLogin) return <Outlet />;

  if (state === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <ShieldCheck className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-xl font-bold text-foreground">Acceso denegado</h2>
          <p className="text-sm text-muted-foreground mt-2">Tu cuenta no tiene permisos de administrador.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={async () => {
              await supabase.auth.signOut();
              nav({ to: "/admin/login" });
            }}
          >
            Cerrar sesión
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-secondary/40">
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-[var(--gradient-brand)] flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-base font-bold text-foreground">Panel de Administración</h1>
              <p className="text-xs text-muted-foreground">Control de Asistencia</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <Clock className="h-4 w-4 mr-1" />
                Ir a marcaje
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await supabase.auth.signOut();
                nav({ to: "/admin/login" });
              }}
            >
              <LogOut className="h-4 w-4 mr-1" />
              Salir
            </Button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}