# PomodoroXII Frontend

PomodoroXII 前端 — 基于 Next.js 15 的离线优先番茄钟应用客户端。
使用 Dexie.js 管理 IndexedDB 本地数据，支持客户端 sync 层与后端 REST API 对接。

## 技术栈

| 技术 | 版本 | 说明 |
|------|------|------|
| Next.js | 15.5.20 | App Router + Turbopack |
| React | 19.1.0 | 启用 React Compiler |
| Tailwind CSS | v4 | via @tailwindcss/postcss |
| Dexie.js | ^4.4.4 | IndexedDB 封装，当前 schema v16 |
| shadcn | ^4.13.0 | UI 组件（基于 @base-ui/react） |
| Zustand | ^5.0.14 | 状态管理 |
| Vitest | ^4.1.9 | 测试框架 + fake-indexeddb |

> **React Compiler 配置说明**：Next.js 15.5 中 React Compiler 通过
> `next.config.ts` 的 `experimental.reactCompiler: true` 启用（非 Next 16
> 的顶层 `reactCompiler: true`）。构建日志会输出 `✓ reactCompiler` 确认生效。

## 前置条件

- Node.js >= 20
- 后端服务运行在 `http://localhost:8000`（用于 API 代理与 openapi 生成）

## 快速开始

### 安装依赖

```bash
cd frontend
npm install
```

### 环境变量

复制示例文件并按需修改：

```bash
cp .env.local.example .env.local
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXT_PUBLIC_API_BASE` | `http://localhost:8000` | 后端 API 基地址 |

> 开发模式下，`next.config.ts` 的 `rewrites()` 会将 `/api/:path*`
> 代理到 `${NEXT_PUBLIC_API_BASE}/api/:path*`，实现跨域请求转发。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（Turbopack），访问 http://localhost:3000 |
| `npm run build` | 生产构建（Turbopack），React Compiler 生效 |
| `npm run start` | 启动生产服务器 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | TypeScript 类型检查（tsc --noEmit） |
| `npm run test` | 运行 Vitest 测试（jsdom + fake-indexeddb） |
| `npm run generate:api` | 从后端 openapi.json 生成 TypeScript 类型 |

### Gate 检查

提交前需全部通过：

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

## 项目结构

```
frontend/
├── src/
│   ├── app/              # Next.js App Router 页面
│   ├── components/ui/    # shadcn UI 组件
│   ├── services/         # Dexie 数据库封装 (database.ts)
│   ├── types/            # TypeScript 类型定义
│   ├── lib/              # 工具函数 (cn 等)
│   └── utils/            # 常量、格式化、辅助函数
├── next.config.ts        # Next.js 配置（reactCompiler、API rewrites）
├── vitest.config.ts      # 测试配置
└── vitest.setup.ts       # 测试环境初始化（UTC 时区、fake-indexeddb）
```

## 测试

测试使用 Vitest + jsdom + fake-indexeddb：
- `vitest.setup.ts` 固定时区为 UTC，安装 fake-indexeddb 使 Dexie 在 jsdom 下正常工作
- 测试文件与源文件同目录，命名 `*.test.ts`

## 已知技术债

| 项 | 说明 | 计划时机 |
|----|------|----------|
| `Note.content` 字段 | `types/index.ts` 中 `Note.content: string` 仍保留全文；后端 Phase D 已 metadata/content 分离 | S3 notes 前对齐 `CachedNote` |
| `OutboxEvent.entityType` 枚举 | 缺 10 个类型（report/reportTemplate/sessionEvent/sessionContext/cognitiveMark/tag/taskTag/taskRelation/focusPattern/reflectionTemplate） | S1 Sync 重建 outbox 时扩展 |
| `api-generated.ts` 未生成 | `npm run generate:api` 脚本已就绪，但需后端运行 | S0-2 backend 联调时执行 |

## 许可

私有项目。
