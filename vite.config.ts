import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./client", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/client", import.meta.url));
const publicDir = fileURLToPath(new URL("./public", import.meta.url));

export default defineConfig({
  root,
  publicDir,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": root,
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/uploads": "http://localhost:4000",
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
