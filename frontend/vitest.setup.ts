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

/**
 * ★ 2026-09-11：jsdom 的 Range 没有实现布局测量方法（getClientRects /
 * getBoundingClientRect），CodeMirror 的测量代码会抛未捕获异常 ——
 * src/lib/editor/image-preview.test.ts 用例本身全过（12 passed），但 vitest
 * 把它记为 "1 error" 并让**全量退出码变成 1**（拿退出码当门禁时会误伤，
 * 2026-09-11 验收实测）。这里补最小空实现：测量静默失败（空矩形列表），
 * 不引入任何 DOM 语义变化；只在该方法缺失时补齐（不覆盖真实实现）。
 */
const emptyRect = {
  x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
  toJSON: () => ({}),
} as unknown as DOMRect;
const emptyRectList = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
} as unknown as DOMRectList;

if (typeof Range !== "undefined") {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto.getClientRects !== "function") {
    proto.getClientRects = () => emptyRectList;
  }
  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = () => emptyRect;
  }
}
