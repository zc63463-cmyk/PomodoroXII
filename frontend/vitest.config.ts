import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // 2026-09-10：React Flow 的样式表会把 Vitest 拖进 PostCSS 管线
      //（Tailwind v4 的 postcss 配置 Vite 读不懂）。测试不需要真实样式，
      // 统一重定向到空桩。
      "@xyflow/react/dist/style.css": fileURLToPath(
        new URL("./vitest.style-stub.js", import.meta.url),
      ),
    },
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
    // 2026-09-10：测试不处理 CSS —— 组件里 import 进来的样式表一律空过。
    css: false,
    // 2026-09-04：曾留下 9 组孤儿进程挂了 4~21 小时（CPU 仅 0.8~1.8s、内存 19MB，
    // 即启动后立刻僵死）。显式钉死 forks 池——它是独立子进程，teardown 超时后能被
    // 真正 kill；threads 池的主线程 terminate worker 失败会导致主进程空等。
    // 不要改回 threads，也不要删掉 teardownTimeout（它是进程能自行退出的最后兜底）。
    pool: "forks",
    teardownTimeout: 30000,
    // 2026-09-04：默认 5000ms 对仓储层测试不够 —— 它们要初始化
    // fake-indexeddb + Dexie，单个就要 2 秒以上；全量并发（134 文件）时
    // 机器负载更高，会偶发超时假红。单独跑都通过，属测试脆弱性。
    // ⚠️ 放宽超时会掩盖「真的变慢」，所以慢测试仍需单独关注。
    testTimeout: 15000,
  },
});
