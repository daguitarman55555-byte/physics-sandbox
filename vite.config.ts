import { defineConfig } from 'vite';

// Rapier ships as WASM. The `@dimforge/rapier3d-compat` build inlines it (base64), so no special
// headers or plugins are needed — it "just works" with Vite's default config.
export default defineConfig({
  server: { host: true, open: false },
  build: { target: 'esnext' },
});
