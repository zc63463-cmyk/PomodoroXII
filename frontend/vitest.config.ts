import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // 2026-09-02: 挂上 react 插件，开启 JSX transform。
  // 此前 vitest 无 JSX transform（tsconfig 的 jsx:"preserve" 优先级高于
  // esbuild.jsx，实测配置 esbuild 无效），导致 src 下 21 个用 JSX 编写的
  // 组件无法被任何测试导入。该插件会强制接管转换，绕过 tsconfig。
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
