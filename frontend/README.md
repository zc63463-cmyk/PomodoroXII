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
> 代理到 `${NEXT_PUBLIC_API_BASE}/api/:path*`。业务代码 REST 前缀为 **`/api/v1`**
> （见 `src/lib/platform.ts` → `API_V1_PREFIX`，F0 HC-1）。

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

## S0 进度与 F0 对齐

设计契约：`.trae/documents/f0-platform-shell-exploration.md`（**F0-A v1.0**）

| S0 段 | 状态 | F0 章节 |
|-------|------|---------|
| **S0-1** 工程 + Dexie v16 | ✅ 完成 | §3.4 SyncFields、§3.5 deletion_state、附录 B |
| **S0-2** 双 JWT + SpaceDBManager | ✅ 完成 | §2.4、§3.1–3.3、§3.2.1 **T29**、§3.2.2 useDexieDB |
| S0-3 Shell + 路由 | ⏳ | §4、§5 |
| S0-4 stores + sync stub | ⏳ | §7、§8、附录 E |

### S0-1 已对齐项

| F0 要求 | 实现 |
|---------|------|
| 无 `export const db` 单例 | ✅ 仅 `PomodoroXIDB` 类 |
| Dexie v16 + SyncFields | ✅ `database.ts` + `types/sync.ts` |
| `deletion_state` vs `trashed_at` | ✅ v16 upgrade 测试覆盖 |
| HC-7 localStorage keys | ✅ `lib/platform.ts` |
| per-space DB 命名 | ✅ `dexieDbNameForSpace()` |
| `api-generated.ts` | 🟡 stub（S0-4 前 generate） |

### S0-2 已对齐项

| F0 要求 | 实现 |
|---------|------|
| 双 JWT Axios（metaApi + spaceApi） | ✅ `services/api.ts` |
| reissueMutex 单飞（F0 §2.4） | ✅ `tryReissueSpaceToken` IIFE + `reissuePromise` |
| CF 530/521/522/523/524 重试 | ✅ `handleCloudflareRetry` 指数退避 |
| `__retried` / `__cfRetryCount` 分离 | ✅ 修复 F0 `__retryCount` 冲突 bug |
| SpaceDBManager + Proxy | ✅ `services/space-db.ts`（`_currentSpaceId` 修复） |
| `export const db = proxy` | ✅ 非 singleton，Proxy 透明转发 |
| MetaDB（pxii_meta）空间缓存 | ✅ `services/meta-database.ts` |
| auth/space stores | ✅ `stores/auth-store.ts` + `stores/space-store.ts` |
| `useDexieDB` hook | ✅ `hooks/use-dexie-db.ts`（useMemo deps=spaceId） |
| SSR 安全 token storage | ✅ `lib/token-storage.ts`（isBrowser 守卫） |
| 无 `window.location` redirect | ✅ S0-2 约束（S0-3 加路由 redirect） |
| D8 预留 `has_password` | ✅ 恒 `false`，`_spacePassword` 保留但不用 |

### T29 验证结果（F0 §3.2.1 O1 closure）

**T29 (Proxy + liveQuery): PASS**

- `liveQuery(() => db.tasks.toArray())` 通过 `SpaceDBManager.proxy` 成功订阅数据变更
- Proxy 的 `get` trap 将方法 bind 到 `manager.current`（real DB），liveQuery 正常工作
- 结论：F0 O1 closure 达成，F0 可升级至 v1.0

## 项目结构

```
frontend/
├── src/
│   ├── app/              # Next.js App Router（S0-3 扩展 auth/app 路由组）
│   ├── components/ui/    # shadcn UI 组件
│   ├── hooks/
│   │   └── use-dexie-db.ts  # useMemo deps=spaceId (F0 §3.2.2)
│   ├── services/
│   │   ├── database.ts      # PomodoroXIDB (Dexie v16)
│   │   ├── api.ts           # metaApi + spaceApi 双 Axios (F0 §2.4)
│   │   ├── auth-api.ts      # setup/login/verify 薄封装
│   │   ├── spaces-api.ts    # listSpaces/createSpace/issueToken
│   │   ├── space-db.ts      # SpaceDBManager + Proxy (F0 §3.1)
│   │   └── meta-database.ts # pxii_meta 空间缓存 (F0 §3.3)
│   ├── stores/
│   │   ├── auth-store.ts    # Zustand auth 状态 (F0 §7.3.1)
│   │   └── space-store.ts   # Zustand space 状态 (F0 §7.3.2)
│   ├── types/
│   │   ├── sync.ts       # SyncFields + plumbing 表常量 (F0 §3.4)
│   │   ├── api-generated.ts  # openapi stub → S0-4 替换
│   │   └── index.ts      # 领域模型 + Cached*
│   ├── lib/
│   │   ├── platform.ts   # HC-7 keys、API_V1_PREFIX、DB 命名 (F0 附录 B)
│   │   ├── token-storage.ts  # SSR 安全双 JWT 存取
│   │   └── utils.ts      # cn() 等
│   └── utils/            # 常量、格式化
├── next.config.ts
├── vitest.config.ts
└── vitest.setup.ts
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
| `api-generated.ts` | 当前为 **stub**；S0-4 Gate 前运行 `npm run generate:api` 替换 | S0-4 |

## 许可

私有项目。
