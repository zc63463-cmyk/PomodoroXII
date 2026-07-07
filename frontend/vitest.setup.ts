/**
 * Vitest 全局测试环境初始化。
 * 固定时区为 UTC，使依赖日期的测试跨开发机确定。
 * 安装 fake-indexeddb，使 Dexie 在 jsdom（无原生 IndexedDB）下正常工作。
 * 注册 @testing-library/jest-dom matchers（toBeInTheDocument / toBeDisabled 等）。
 */
process.env.TZ = "UTC";

import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
