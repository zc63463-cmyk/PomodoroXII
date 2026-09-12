// Vitest 样式桩：测试环境不需要任何真实样式。
// 用途见 vitest.config.ts —— 把 `@xyflow/react/dist/style.css` 等
// 第三方样式表别名到这里，绕开 Vitest/Vite 的 PostCSS 管线
// （Tailwind v4 的 postcss 配置只有 Next 读得懂，Vite 会报
// “Invalid PostCSS Plugin found at: plugins[0]”）。
export {}
