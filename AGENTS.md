# dsh-codex-project 仓库规则（AGENTS）

> 本文只含**项目全局开发规则**（面向贡献者与 agent）。项目架构、数据模型、路由、fence 语义、client 结构等 → [README.md](README.md)。

---

## 1. 仓库硬约束（必须遵守）

- **禁止修改 DSH 源码**：对官方仓库（<https://github.com/deepseek-ai/deepseek-harness>）的检出零写入。需要 DSH 没有的能力时，优先用公开/只读 API 或插件自有路由；确实做不到，先向用户说明取舍，不改 DSH。
- **代码改动必须走 PR**：非文档改动在 `feat/*` / `fix/*` 分支开发，review 合并后进 main；**仅纯文档改动**（README / AGENTS.md / docs/）允许直推 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**，插件作为独立包被 profile 引用，不反向侵入 DSH。
- **client 纯度门**：client bundle 只能 value-import 平台模块白名单（`tsdown.config.ts` 的 `CLIENT_EXTERNALS`）；与其他插件的运行时交互一律走 cordis 服务方法调用，`import type {}` 可共享类型但不产生运行时依赖。
- **browser bundle 无 `node:path`**：路径字符串运算必须放 `src/client/paths.ts`（`basename` / `relativePath` / `resolvePath` / `samePath`），不许 import node 内置。
- **侧边栏只挂原生 DSH 右侧栏**：`ctx.sidebarRightTabs` 注册 page 类型 + `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 键控 seat（见 `src/client/native-sidebar.tsx`）。0.1.6 的 web 组合默认自带该承载，所以 better-sidebar 回退线已删（`preview-tab.tsx` 不再存在）。better-sidebar ≥0.19 会把 tab 转发进同一原生面，**再往 `betterSidebar.registerTab` 注册就会出两个 tab**，不要恢复。
- **别把承载包写进 `dsh.client.inject`**：`@deepseek-ai/dsh-client-ui-sidebar-right` 只被 `import type` 级别地引用（实际全是结构化再声明），而 `dsh.client.inject` 的行是**加载/组合边**（该行工厂必须先到位，cordis 还用它组合 entries），不是「可 value-import 白名单」。它也不在 web shell 的 `PLATFORM_MODULES` 里——加进去等于给一个可选承载加了包级硬耦合，正是 `ctx.inject` 子 fiber 要小心避开的那种绑法。
- **原生服务的等待方式**：用 `ctx.inject(['sidebarRightTabs','slots','sessions'], cb)` 挂子 fiber，**别**在 `apply` 里 `reflect.get` 一次性探测（本插件与 `ui-sidebar-right` 谁先 apply 由组合顺序决定，一次性探测可能永久漏掉；注意 `ui-sidebar-right` **自己内部**是先 provide `sidebarRightTabs` 再声明 seat，会抢跑的是跨插件这一层，别把这条因果记反）；也**别**把它们加进模块级 `inject` 数组（可选服务进 `inject` 会让整个插件 fiber 永久 pending，连工作区菜单入口一起挂不上）。`ctx.inject` 回调返回的函数由 cordis 当作 disposer 收集，fiber 卸载时自动回收。
- **传进组件的 runtime ctx 必须显式合成**：cordis 给插件的 `ctx` 是代理，**声明的 `inject` 列之外、又非内置面的服务属性一律读成 `undefined`**——`ctx.sessions` 正是如此（`insertFileReference` 只写 `ctx.sessions?.scope(...)`，拿到 undefined 就静默 return，「引用到对话」不报错也不干活）。所以别把 `ctx` 用 `as never` 塞给 `ClientRuntimeContext`：在 `ctx.inject` 回调里用真正持有的服务拼一张 `{ get, sessions }` 再往下传（见 `src/client/index.tsx`），类型检查才继续在干活。
- **原生 tab 都是 page 类型**：不声明 `patterns`，只按 kind 打开，绝不与产品自带的文件 viewer 抢 `dsh-resource://file/**`。文件一律交给插件自有的 `codex-project-file` page（走插件自己的多根路由，跨盘共享目录才可预览）。
- **fence 只改一处**：所有项目文件操作路由共用 `dirs-api.ts` 的 `fenceFor`；不要另写一份 roots 推导（否则三处漂移）。

---

## 2. 构建与验证

```bash
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（18 个文件 / 218 用例）
pnpm build              # tsc(types) + tsdown（host ESM + client CJS + runner + fs）
pnpm proto:verify       # 多根 runner 原型实证（Windows ACL，需先 build）
```

- **产物**：`lib/index.js`（host）、`lib/runner.js`、`lib/fs.js`、`lib/client.js`（浏览器 bundle，CJS closure 工厂注册 id `dsh-codex-project`）。
- **宿主基线**：`@deepseek-ai/dsh-*` peer 一律 `^0.1.6-alpha.2`（已在发布版 0.1.6-alpha.2 上完成真机挂载验证）；`@deepseek-ai/cordis` `^4.0.2`。**别写回 `^0.1.2-alpha.4` / `^0.1.5-rc.1`**——semver 普通范围不匹配预发布版本，会拒绝 0.1.6-alpha.x。
- **`dsh-client-ui-primitives` 不声明 `dependencies`**：其 bundle 裸 import `shiki` / `@shikijs/langs/*` / `anser` / `clsx` / `katex` / `mdast-util-*` / `micromark-*` / `diff` / `simple-icons`（0.1.6 起了 DiffBlock 又加进 `diff`+`simple-icons`）。这组包**必须留在 devDependencies**（浏览器用例的 resolve 依赖它们），不得"清理"掉；升 primitives 版本后先 `grep -ohE "from ['\"][^./]" lib/…/dsh-client-ui-primitives/lib/index.js` 对一遍清单。
- **`tsconfig.build.json` 的 `rootDir` 必须是 `src`**：设成 `.` 会让声明落到 `lib/types/src/*`，与 package.json 的 `types` 子路径错位，消费者拿不到类型。
- **client 白名单**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`。纯度门插件在 resolve 阶段拒绝任何其他 `@deepseek-ai/*` value import 与 node 内置。
- 白名单改动（加新 `@deepseek-ai` 依赖前）务必确认它在 web shell 的 `PLATFORM_MODULES`（`packages/client/web/src/platform.ts`）共享表里，否则运行时解析失败。

---

## 3. 挂载

1. **官方通道**：`dsh plugin --profile <name> add <pkg>`（协调 `dsh.profile.bundles` 并应用 `cordis.patch.yml`）。**0.1.6-alpha.2 真机验证走的就是这条**：装进 `web` profile 后 `dsh web`，「项目文件夹」「文件预览」两个 tab 正常出现。
2. **本地开发**：dsh 源码检出根目录 `pnpm dsh web --patch <本仓库绝对路径>/cordis.patch.yml`。bundle patch 会把 `lib/fs.js` 插为 fs 提供者、禁用核心 fs-sandbox 行。
3. **`dev.patch.yml`（file:// 两行）在 0.1.6 会被拒**：`client-modules` 现在按**包名**归并 Loader 源，`file:///…/lib/index.js` 与 `file:///…/lib/fs.js` 同属一个 package.json → 直接报 `package … resolves from multiple active Loader sources; remove one entry`，插件 client 进不了模块图（侧边栏不出现）。用包名的 `cordis.patch.yml` 没这个问题。要免 install 挂载就别再用两行 file://。该文件里的行现已**全部注释掉**（只留「为什么不能用」的记录）——注意 `fs-sandbox: disabled` 那行也不能单独生效：禁了核心 fs 提供者又不挂插件自己的，宿主会完全没有 fs 提供者。
4. **热加载**：client 改动浏览器硬刷新即可；**host 改动（路由、seam、fs、runner）需重启 `dsh web`**。
5. `pnpm plugin add` 报 `ERR_PNPM_IGNORED_BUILDS` 时，把 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 占位符改成布尔值后重跑。

---

## 4. 测试守护

`tests/`（vitest，browser 组件用 jsdom）：

- `dirs-api.spec.ts` — CRUD + 锚定 + 失效根 + 项目解析 + 目录列表（排序/fence 403/跨盘根）+ 读/写/文件字节与下载 disposition。
- `project-tab.spec.tsx` — 无配置回退单根、根行（主/共享/缺失）、懒加载、点击把文件交给 `openPreview`（预览页本身在 `native-sidebar.spec.tsx`）、右键菜单。
- `file-reference.spec.ts` — @ 引用源注册 / 注入 / 序列化。
- `client-apply.spec.tsx` / `client-components.spec.tsx` — 插件形态、菜单注入、管理弹窗。
- `native-sidebar.spec.tsx` — 原生右侧栏两阶段注册（type/body/title 的 id 与 key）、page body 经 `tab.actions.openTab` 打开自有预览、`navigation.params` 读取与 chip 标题回退、`useTabInfo` 抛错时的等待态、晚到的 carrier、unload 回收、**传下去的 runtime ctx 真能拿到 `sessions.scope`/`conversation`**（fake 如实建模 cordis 代理会吞掉 `ctx.sessions`）、**同一文件被再次导航（revision 变了）会重读**。
- `native-sidebar-composition.spec.ts` — 拿真实 `SlotCore` 验证键控 seat：未声明的 seat 注册不抛（这正是走 `slots.inject` 而非直接 `register` 的理由）、声明后落两个 key、dispose 全回收。
- `fs-fence.spec.ts` / `seam-wiring.spec.ts` — 多根 fence 收窄/隔离/自愈、runner 接线。
- `context-injection.spec.ts` — 上下文提醒（文本组成/折叠位置/去重/缺失标注）。
- `add-dir.spec.ts` — add-dir 工具（校验/审批/持久化）。
- `plugin-shape.spec.ts` — 插件导出形态。

新增 API 面（如 `SpacesApi` 加方法）时，记得同步更新各测试里的 fake（`readFile/writeFile/fileUrl/downloadUrl` 等），否则 typecheck 会因缺方法失败。

---

## 5. 开发规则速查

- **CodeMirror host 必须始终挂载**：`<div className="dsh-cxp-preview-cm" ref={hostRef} hidden={!inEdit}>` 的节点不能条件卸载——视图创建 effect 依赖 `[path, language]`（不含 `mode`），若预览态不渲染 host，effect 在 `host === null` 提前返回，切到编辑后不重跑 → 空白页。用 `hidden` 隐藏而非卸载。
- **CodeMirror 视图别按 base/content 重建**：按 `path` 常驻；换文件用 `key={`${path}#${navigation.revision}`}` 让 `PreviewPane` 整体重挂载（`native-sidebar.tsx` 的 `NativeFileTab` 已这么做——`revision` 每次导航都自增，所以「重点同一个文件」也会重读，不会留下 agent 改过之后的旧内容）。预览页故意不声明 `multiple`，同一 pane 只有一个 `codex-project-file`，再次打开即「导航它」而不是再叠一个。
- **`updateListener` 是 `CodeMirrorView.updateListener.of(...)`**，不是 `EditorState.updateListener`（那不存在）。
- **`import.meta` / node 内置**：只存在于 host 侧 `src/*.ts`；client 一律用 `paths.ts`。
- **路径比较大小写**：Windows 上 `samePath`/`relativePath`/`isPathUnder`（`containment.ts`）都按平台大小写约定处理；跨盘符返回绝对路径回退。
