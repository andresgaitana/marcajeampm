import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Recarga la página UNA vez (con guarda anti-bucle) para tomar la versión nueva
 * cuando un chunk quedó obsoleto tras un despliegue. */
function reloadForStaleChunk(): boolean {
  if (typeof window === "undefined") return false;
  const KEY = "app-chunk-reload";
  const last = Number(sessionStorage.getItem(KEY) || "0");
  if (Date.now() - last > 15000) {
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
    return true;
  }
  return false;
}
const STALE_CHUNK_RE = /dynamically imported module|Loading chunk|Importing a module script failed|Failed to fetch/i;

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
    // Si el error es por un chunk obsoleto (despliegue nuevo), recargar solo.
    if (STALE_CHUNK_RE.test(String(error?.message || ""))) reloadForStaleChunk();
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          No se pudo cargar la página
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ocurrió un error. Toca “Recargar” para obtener la versión más reciente.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Recargar
          </button>
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Reintentar
          </button>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      // Refuerza el translate="no" del <html>: el traductor de Chrome reescribe los
      // nodos de texto y hace fallar el renderizado de React.
      { name: "google", content: "notranslate" },
      { title: "AM/PM Centroamérica - Marcaje" },
      { name: "description", content: "Sistema de marcaje y control de asistencia para tiendas AM/PM Centroamérica." },
      { name: "author", content: "AM/PM Centroamérica" },
      { property: "og:title", content: "AM/PM Centroamérica - Marcaje" },
      { property: "og:description", content: "Sistema de marcaje y control de asistencia para tiendas AM/PM Centroamérica." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@ampmcentroamerica" },
      { name: "twitter:title", content: "AM/PM Centroamérica - Marcaje" },
      { name: "twitter:description", content: "Sistema de marcaje y control de asistencia para tiendas AM/PM Centroamérica." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/204ec2dd-646e-4777-a9c9-bb0bbfc314dc/id-preview-b4515165--56637313-4367-4cb5-8ba5-e15dbad436fb.lovable.app-1780578485416.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/204ec2dd-646e-4777-a9c9-bb0bbfc314dc/id-preview-b4515165--56637313-4367-4cb5-8ba5-e15dbad436fb.lovable.app-1780578485416.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    // lang="es": la app está en español. Estaba declarada como inglés, así que Chrome
    // detectaba "página en otro idioma" y ofrecía traducirla; al traducir reemplaza los
    // nodos de texto por otros suyos y React truena al intentar quitar los originales
    // ("Error al ejecutar 'removeChild'"), tumbando la sección completa.
    // translate="no" evita además que la traduzcan a propósito y rompan la app.
    <html lang="es" translate="no">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    // Auto-recuperación de tablets con versión vieja en caché: si un módulo/chunk quedó
    // obsoleto tras un despliegue nuevo, recargar una vez para tomar la versión actual.
    const onPreload = (e: Event) => { e.preventDefault(); reloadForStaleChunk(); };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = String((e?.reason as { message?: string })?.message ?? e?.reason ?? "");
      if (STALE_CHUNK_RE.test(msg)) reloadForStaleChunk();
    };
    window.addEventListener("vite:preloadError", onPreload);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("vite:preloadError", onPreload);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  );
}
