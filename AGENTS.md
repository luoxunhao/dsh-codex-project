# dsh-codex-project 仓库规则（AGENTS）

> 本文只含**项目全局开发规则**（面向贡献者与 agent）。项目架构、数据模型、路由、fence 语义、client 结构等 → [README.md](README.md)。

---

## 1. 仓库硬约束（必须遵守）

- **禁止修改 DSH 源码**：对官方仓库（<https://github.com/deepseek-ai/deepseek-harness>）的检出零写入。需要 DSH 没有的能力时，优先用公开/只读 API 或插件自有路由；确实做不到，先向用户说明取舍，不改 DSH。
- **代码改动必须走 PR**：非文档改动在 `feat/*` / `fix/*` 分支开发，review 合并后进 main；**仅纯文档改动**（README / AGENTS.md / docs/）允许直推 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**，插件作为独立包被 profile 引用，不反向侵入 DSH。
- **client 纯度门**：client bundle 只能 value-import 平台模块白名单（`tsdown.config.ts` 的 `CLIENT_EXTERNALS`）；与其他插件的运行时交互一律走 cordis 服务方法调用，`import type {}` 可共享类型但不产生运行时依赖。
- **browser bundle 无 `node:path`**：路径字符串运算必须放 `src/client/paths.ts`（`basename` / `relativePath` / `resolvePath` / `samePath`），不许 import node 内置。
- 本插件通过 `betterSidebar.registerTab` 接入侧边栏（仅当 better-sidebar 安装时注册）；不直接操作其内部运行时符号。
- **fence 只改一处**：所有项目文件操作路由共用 `dirs-api.ts` 的 `fenceFor`；不要另写一份 roots 推导（否则三处漂移）。

---

## 2. 构建与验证

```bash
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（12 个文件）
pnpm build              # tsc(types) + tsdown（host ESM + client CJS + runner + fs）
pnpm proto:verify       # 多根 runner 原型实证（Windows ACL，需先 build）
```

- **产物**：`lib/index.js`（host）、`lib/runner.js`、`lib/fs.js`、`lib/client.js`（浏览器 bundle，CJS closure 工厂注册 id `dsh-codex-project`）。
- **client 白名单**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`。纯度门插件在 resolve 阶段拒绝任何其他 `@deepseek-ai/*` value import 与 node 内置。
- 白名单改动（加新 `@deepseek-ai` 依赖前）务必确认它在 web shell 的 `PLATFORM_MODULES`（`packages/client/web/src/platform.ts`）共享表里，否则运行时解析失败。

---

## 3. 挂载

1. **官方通道**：`dsh plugin --profile <name> add <pkg>`（协调 `dsh.profile.bundles` 并应用 `cordis.patch.yml`）。
2. **本地开发**：dsh 源码检出根目录 `pnpm dsh web --patch <本仓库绝对路径>/cordis.patch.yml`。bundle patch 会把 `lib/fs.js` 插为 fs 提供者、禁用核心 fs-sandbox 行。
3. **热加载**：client 改动浏览器硬刷新即可；**host 改动（路由、seam、fs、runner）需重启 `dsh web`**。
4. `pnpm plugin add` 报 `ERR_PNPM_IGNORED_BUILDS` 时，把 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 占位符改成布尔值后重跑。

---

## 4. 测试守护

`tests/`（vitest，browser 组件用 jsdom）：

- `dirs-api.spec.ts` — CRUD + 锚定 + 失效根 + 项目解析 + 目录列表（排序/fence 403/跨盘根）+ 读/写/文件字节与下载 disposition。
- `project-tab.spec.tsx` — 无配置回退单根、根行（主/共享/缺失）、懒加载、点击即内联预览、右键菜单。
- `file-reference.spec.ts` — @ 引用源注册 / 注入 / 序列化。
- `client-apply.spec.tsx` / `client-components.spec.tsx` — 插件形态、菜单注入、管理弹窗。
- `fs-fence.spec.ts` / `seam-wiring.spec.ts` — 多根 fence 收窄/隔离/自愈、runner 接线。
- `context-injection.spec.ts` — 上下文提醒（文本组成/折叠位置/去重/缺失标注）。
- `add-dir.spec.ts` — add-dir 工具（校验/审批/持久化）。
- `plugin-shape.spec.ts` — 插件导出形态。

新增 API 面（如 `SpacesApi` 加方法）时，记得同步更新各测试里的 fake（`readFile/writeFile/fileUrl/downloadUrl` 等），否则 typecheck 会因缺方法失败。

---

## 5. 开发规则速查

- **CodeMirror host 必须始终挂载**：`<div className="dsh-cxp-preview-cm" ref={hostRef} hidden={!inEdit}>` 的节点不能条件卸载——视图创建 effect 依赖 `[path, language]`（不含 `mode`），若预览态不渲染 host，effect 在 `host === null` 提前返回，切到编辑后不重跑 → 空白页。用 `hidden` 隐藏而非卸载。
- **CodeMirror 视图别按 base/content 重建**：按 `path` 常驻；切文件用 `key={path}` 让 `PreviewPane` 整体重挂载（`project-tab.tsx` 已这么做）。
- **`updateListener` 是 `CodeMirrorView.updateListener.of(...)`**，不是 `EditorState.updateListener`（那不存在）。
- **`import.meta` / node 内置**：只存在于 host 侧 `src/*.ts`；client 一律用 `paths.ts`。
- **路径比较大小写**：Windows 上 `samePath`/`relativePath`/`isPathUnder`（`containment.ts`）都按平台大小写约定处理；跨盘符返回绝对路径回退。
