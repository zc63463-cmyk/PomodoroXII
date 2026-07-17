/**
 * 性能基线测量脚本 - 在浏览器控制台中运行
 * 用于测量 200/500 条小记数据下的交互性能
 */

(function() {
  const ITERATIONS = 5;
  const results = {};

  // 生成测试数据
  function generateTestNotes(count) {
    const notes = [];
    const tags = ['工作', '灵感', '会议', '待办', '学习', '生活', '技术', '阅读'];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const dayOffset = Math.floor(Math.random() * 30);
      const date = new Date(now - dayOffset * 86400000);
      notes.push({
        id: `perf-test-${i}`,
        content: `这是第 ${i + 1} 条性能测试小记。#${tags[i % tags.length]} 包含一些示例内容用于测试搜索和渲染性能。`,
        tags: [tags[i % tags.length]],
        pinned: i < 3,
        created_at: date.toISOString(),
        updated_at: date.toISOString(),
      });
    }
    return notes;
  }

  // 测量函数执行时间
  function measure(name, fn) {
    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      fn();
      const end = performance.now();
      times.push(end - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    results[name] = { avg: avg.toFixed(2), min: min.toFixed(2), max: max.toFixed(2), iterations: ITERATIONS };
    return results[name];
  }

  // 模拟用户交互
  function simulateSearch(query) {
    const input = document.querySelector('input[aria-label="搜索小记"]');
    if (!input) return null;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function simulateClick(element) {
    if (!element) return null;
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }

  // 主测量流程
  window.runPerfBaseline = function(noteCount) {
    console.log(`开始 ${noteCount} 条数据性能基线测量...`);
    const notes = generateTestNotes(noteCount);

    // 这里需要与实际的 store 交互来注入数据
    // 由于无法直接访问 store，我们通过 UI 操作来测量

    // 1. 测量搜索输入响应
    measure('search-input', () => {
      simulateSearch('测试');
    });

    // 2. 测量清除搜索
    measure('search-clear', () => {
      simulateSearch('');
    });

    // 3. 测量标签筛选切换
    const tagButtons = document.querySelectorAll('[data-tag], .tag, [class*="tag"]');
    if (tagButtons.length > 0) {
      measure('tag-filter-toggle', () => {
        simulateClick(tagButtons[0]);
      });
    }

    // 4. 测量卡片点击
    const cards = document.querySelectorAll('article, [data-quicknote-card]');
    if (cards.length > 0) {
      measure('card-click', () => {
        simulateClick(cards[0]);
      });
    }

    // 5. 测量滚动性能
    measure('scroll-timeline', () => {
      window.scrollTo(0, document.body.scrollHeight / 2);
      window.scrollTo(0, 0);
    });

    console.table(results);
    return results;
  };

  console.log('性能基线测量脚本已加载。运行 window.runPerfBaseline(200) 或 window.runPerfBaseline(500) 开始测量。');
})();
