import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Builds to ../caddy/v2/, served by the reverse-proxy at /v2/* on the
// torhole virtual host. The legacy UI continues to live at /.
export default defineConfig({
  base: "/v2/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "../caddy/v2"),
    emptyOutDir: true,
    // Three.js is deliberately isolated in an idle-loaded 519 kB chunk; the
    // operational shell remains below 450 kB and renders before it is fetched.
    chunkSizeWarningLimit: 550,
  },
});
