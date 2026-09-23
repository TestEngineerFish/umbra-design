import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 构建产物由核心在 /__app/ 托管（server/src/serve.ts），资源路径一律以它为基
export default defineConfig({
  plugins: [react()],
  base: "/__app/",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  server: { port: 5173, strictPort: false },
});
