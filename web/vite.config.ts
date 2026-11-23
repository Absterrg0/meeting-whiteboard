import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    // The web app imports shared types/constants from ../src.
    fs: { allow: [projectRoot] },
    proxy: {
      "/api": { target: `http://localhost:${process.env.PORT ?? 8787}`, changeOrigin: true, ws: true },
    },
  },
});
