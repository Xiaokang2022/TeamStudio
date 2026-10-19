import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // monaco-editor（VS Code 内核）本身体积较大，将其中立拆成独立 chunk 便于浏览器缓存；
    // monaco 单 chunk ~3MB 属预期，因此放宽 warning 阈值，其余 chunk 仍保持拆分。
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          return undefined;
        },
      },
    },
  },
});
