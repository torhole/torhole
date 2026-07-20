import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Builds to an internal Caddy asset directory. Public URLs are unversioned;
// Caddy serves this SPA at the Torhole host root.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, "../caddy/admin-ui"),
    emptyOutDir: true,
    // Three.js is deliberately isolated in an idle-loaded 519 kB chunk; the
    // operational shell remains below 450 kB and renders before it is fetched.
    chunkSizeWarningLimit: 550,
  },
});
