import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 构建产物由核心在 /__app/ 托管（server/src/serve.ts），资源路径一律以它为基
export default defineConfig({
  plugins: [react()],
  base: "/__app/",
  /* 文件类型的定义只有一份，放在 server/src/shared/ ——
     前后端各留一份扩展名映射的话，今天一致纯属运气，明天就会漂。
     它是纯 TypeScript、不碰 Node 也不碰 DOM，所以两边都能直接编。 */
  resolve: { alias: { "@shared": fileURLToPath(new URL("../server/src/shared", import.meta.url)) } },
  // dev server 要放行项目目录之外的那一份（build 不受这个限制）
  server: { port: 5173, strictPort: false, fs: { allow: [".", "../server/src/shared"] } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
});
