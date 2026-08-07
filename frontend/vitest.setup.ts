/**
 * Vitest 全局测试环境初始化。
 * 固定时区为 UTC，使依赖日期的测试跨开发机确定。
 * 安装 fake-indexeddb，使 Dexie 在 jsdom（无原生 IndexedDB）下正常工作。
 * 注册 @testing-library/jest-dom matchers（toBeInTheDocument / toBeDisabled 等）。
 */
process.env.TZ = "UTC";

import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

class VitestLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  request<T>(name: string, _options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(callback);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(name, tail);
    void tail.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
    return result;
  }
}

Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: new VitestLockManager(),
});
