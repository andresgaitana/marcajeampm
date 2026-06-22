// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Deploy target. Inside the Lovable sandbox this is ignored (the wrapper forces
  // "cloudflare-module"); outside it (e.g. Vercel CI) Nitro builds the Vercel
  // Build Output API (.vercel/output). Setting `nitro` also force-enables the
  // deploy plugin, which the wrapper otherwise skips when no Lovable context is detected.
  nitro: { preset: "vercel" },
  // Disable production sourcemaps: rollup ran out of memory decoding dependency
  // sourcemaps during the bundle. Sourcemaps aren't needed in the prod bundle and
  // dropping them keeps the build well within memory limits.
  vite: {
    build: { sourcemap: false },
  },
});
