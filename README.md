# dsh-codex-project

**DSH 工作区共享子目录插件** —— 源自 Codex 的项目处理思想：一个工作区可以挂载任意数量的**共享子目录**（可跨盘符），该工作区的 DSH 会话可以像对待自己的工作区一样读写这些目录——全程保持 `workspace-write` 权限，**永远不需要 `danger-full-access`**。

---

## 设计思想

Codex 处理项目时，一个"项目"往往横跨多个目录：主代码库、共享库、文档、数据目录。传统做法要么给模型 full access（危险），要么逐个授权（繁琐）。

本插件的模型是 **Codex 式的项目共享**：

```
一个共享配置（记录）= 一个主根（该工作区自身的 path）+ 任意数量的共享子目录（跨盘符）
命中该配置的会话 → 可读写该配置的全部可写根（主根 ∪ 现存共享子目录）
```

- **单配置模型**：会话的可写集合 = 其 cwd 命中的那一条配置的可写根（无并集、无叠加），行为可预期；
- **单边命中**：会话 cwd（规范路径）== 某条记录的 `path` 即命中该条记录（锚定）；共享子目录里的会话不会仅因该目录出现在别人配置里而命中；
- **不强制注册**：共享子目录可以是裸目录，不必是 DSH 注册的工作区；
- **不升级权限**：仍在 `workspace-write` 权限级内，只是把可写集合从单根扩展为多根（Windows ACL 受限令牌 + 空间级 SID）。

## 功能特性

| 能力 | 说明 |
|---|---|
| 共享子目录配置 | 每个工作区可配置任意数量共享子目录（跨盘符、可裸目录） |
| 「管理工作区」弹窗 | 原生工作区「…」菜单注入入口：添加/移除共享子目录 |
| 「项目文件夹」tab | better-sidebar 侧边栏注册的项目多根目录树：主根 + 共享子目录（跨盘符），按层懒加载；仿 Files tab 布局（顶部路径输入框 + 右侧可拖拽文件树 + 左侧内联预览与编辑：图片 / PDF / Markdown / HTML / 代码编辑与 Ctrl+S 保存 / 二进制下载），右键目录用文件管理器打开 |
| 「打开本地目录」 | 原生「…」菜单注入入口：用系统文件管理器打开该工作区文件夹（插件自有路由 spawn explorer.exe——不走 workspaces.openPath，避免被 better-sidebar 等插件劫持到侧边栏编辑器） |
| 多根沙箱 runner | 命中配置的会话，shell/subprocess 自动走多根受限令牌（`lib/runner.js`） |
| 多根 fs fence | 进程内 fs 工具（read/write/edit）同样按配置可写根放行（`lib/fs.js`） |
| 会话上下文提醒 | 第一条 user 消息后折叠 `<system-reminder>` 目录清单（英文、零权限声明，模型自己试错） |
| 配置 CRUD + 持久化 | `/codex-project/api` JSON 路由，`~/.dsh-codex-project/dirs.json` |
| add-dir 模型工具 | 模型可通过工具请求添加目录（用户确认后生效），无需手动操作 |

## 架构总览

```
┌─────────────────────────── DSH web ───────────────────────────────────┐
│  (client half)                                                        │
│  侧边栏工作区「…」菜单 ──注入「打开本地目录」+「管理工作区」──▶ 本地动作/弹窗  │
│        │ fetch()                                                      │
│        ▼                                                              │
│  /codex-project/api  (CRUD + 项目目录树，loopback 守卫)                │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  (host half)  四个独立钩子，共用命中判定 matchingWorkspace              │
│                                                                       │
│  ① ctx.webServer.register    ─── HTTP 路由（CRUD / 文件读写）         │
│  ② ctx.on('agent/pre-step')  ─── 折叠 <system-reminder> 目录清单     │
│  ③ ctx.tools.register        ─── add-dir 模型工具                    │
│  ④ sandbox.confine wrap      ─── 多根 runner（lib/runner.js）        │
│                                                                       │
│  ⑤ ctx.fs 提供者（bundle patch 替换核心 fs-sandbox）                  │
│     └── lib/fs.js 多根 fence（与 ④ 共用命中判定）                    │
│                                                                       │
│  配置外 / 单根 / 无 cwd 的会话 → 四个钩子全部纯透传（零影响）         │
└───────────────────────────────────────────────────────────────────────┘
```

## 工作原理

本插件通过 Cordis（DSH 的 IoC 框架）提供的四个钩子切入 DSH 的运行循环，不侵入 DSH 源码。

### 1. HTTP 路由 — client/host 之间的桥梁

```ts
ctx.webServer.register({ kind: 'prefix', path: '/codex-project/api', handler: ... })
```

DSH 启动时，插件把 `/codex-project/api/*` 路由挂到宿主 HTTP 服务器上。client 的 `api.ts` 通过 `fetch()` 调用这些路由，host 侧处理后返回 JSON。配置 CRUD、文件读写、目录列表全部走这条路。

### 2. `agent/pre-step` 事件 — 折叠上下文提醒

```ts
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const decision = await next()
  return foldWorkspaceContext(decision, messages, agent.session)
})
```

DSH 的 agent 循环是：**收消息 → pre-step 事件链 → 模型推理 → 工具执行 → 输出**。`agent/pre-step` 是推理前的最后一道关卡。

插件在这里计算当前会话的共享目录清单，生成 `<system-reminder>` 消息插入模型上下文。这是 **text-idempotent** 的：每次 pre-step 重新计算，文本相同时跳过，不重复叠加。模型因此"知道"自己能读写哪些目录——但只列目录，不声明权限，模型通过工具试错发现边界。

### 3. `ctx.tools.register()` — 注册 add-dir 工具

```ts
ctx.tools.register(defineAddDirTool(deps))
```

注册后模型在推理时可以看到 `add-dir` 工具的 schema，并主动调用它添加新目录。执行流程：

```
模型调用 add-dir(path)
  → 插件通过 ctx.approval.request() 请求用户确认
  → 用户批准 → 写入 dirs.json
  → 目录立即进入可写集合（无状态重校验）
```

### 4. `sandbox.confine` 包装 — 劫持进程沙箱

```ts
const original = sandbox.confine
sandbox.confine = (argv, policy) => {
  // 非 Windows / 非 workspace-write / 无匹配记录 / 单根 → 透传原逻辑
  // 有多根共享目录 → 返回插件 runner.js 的 ConfinedArgv
  return { argv: [node, runner.js, --bind root1, --bind root2, --, ...原命令], ... }
}
```

DSH 在执行 shell 命令时调用 `sandbox.confine(argv, policy)` 决定如何隔离进程。插件 wrap 了这个方法：**无共享目录时行为与 DSH 原生完全一致**；有多根时路由到 `runner.js`，由它在 Windows 上创建受限令牌、给每个存活根授予 Write ACE、在该令牌下 spawn 子进程。

### 数据流全景

```
用户在 GUI 输入命令
  ↓
DSH agent 循环启动
  ↓
pre-step 事件触发 → 插件折叠 <system-reminder>（钩子 2）
  ↓
模型推理（已看到共享目录清单）
  ↓
模型决定执行 shell 命令
  ↓
sandbox.confine → 插件 wrap 决定路由（钩子 4）
  ↓
  ├─ 无共享目录 → 核心 runner（单根 workspace-write）
  └─ 有多根共享目录 → 插件 runner.js（多根受限令牌 + SID）
  ↓
子进程执行，fs 操作经过 ctx.fs（插件的 CodexProjectFileSystem）
  ↓
fs fence 按可写根集合放行/拒绝（与 runner 共用同一命中判定）
```

## 安全模型

- **权限不升级**：多根 runner 仍是 `workspace-write` 受限令牌（拒绝列表 + 空间级 SID 写授权），只是 Write ACE 覆盖配置的可写根；
- **空间级 SID**：每条配置一个专属 SID（`config 目录 + workspace id` 摘要）——核心单根会话的 SID 无法沿着共享目录的 ACE 进入其他根，空间会话的令牌也无法使用别的根的 ACE；
- **失败契约**：runner 任何失败输出 `codex-project-run: <detail>` 并以 127 退出，绝不以非受限方式 spawn 子进程；
- **失效根收窄（narrowing）**：配置里某个共享子目录事后被删除（被动失效）时，可写集合收窄到**现存根**——死根本身物理上已不可写，其存在性失败不阻塞其余根，也不影响任何无关会话；上下文提醒给死根加 `(⚠ directory missing)` 标注，host 日志对每个空间首次 warn 一次、之后 debug；root 目录恢复后无需重启或改配置即可重新进入可写集合（无状态重校验）；
- **模型不被告知权限**：上下文提醒只列目录清单，不声明可读写——模型通过工具试错发现边界，`[sandbox: …]` 拒绝标记不变（缺失标注是目录事实，不是权限声明）。

### 已知边界（设计取舍）

- **重叠根歧义**：同一目录同时是两条记录的 `path` 时，cwd 落在该目录的会话匹配**配置文件中靠前的那条**（可写集合随配置顺序漂移）。建议共享子目录互不重叠；
- **standing ACE 常驻**：runner 在每个根上物化的空间 SID Write ACE 是常驻的（跨会话复用缓存，dispose 只回收私有 temp）。删除配置不会回收已打上的 ACE（孤立 ACE 无令牌携带，无害但会累积）；
- **无只读共享**：所有根都授予读写——想"只读共享"（如只允许读 DSH 源码树）需要后续特性；
- **提醒不重注入**：每会话一次性；恢复的会话若已有相同提醒不再折叠（带着旧文案恢复的会话会在下一条 user 消息后折叠进当前文案）；
- **增删仍校验存在性**：通过 API 保存的共享子目录要求存在（主动操作 fail loud）；只有目录事后消失的被动失效会被收窄，不阻塞其余根。

## 配置文件

默认 `~/.dsh-codex-project/dirs.json`（环境变量 `DSH_CODEX_PROJECT_CONFIG` 可覆盖），形状：

```json
{
  "workspaces": {
    "<workspaceId>": {
      "path": "主根（该工作区自身的路径）",
      "dirs": ["共享子目录1", "共享子目录2"]
    }
  }
}
```

- `path` 恒为该工作区自己的主根（锚定，记录键即工作区 id）；`dirs` 为额外可写目录；
- 缺省文件 = 无配置 = 纯透传；
- **失效根不自动清理**：目录消失不会改写配置文件（对齐 DSH 核心"被动失效保留记录、降级显示"策略）；通过「管理工作区」弹窗或 API 显式移除。

## HTTP API

`/codex-project/api` 前缀（loopback Host 守卫），全部 JSON：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 挂载冒烟 |
| GET | `/dirs?workspaceId=<id>` | 某工作区的共享子目录列表（无记录返回空数组；只有未知 id 才 404） |
| PUT | `/dirs` | 替换某工作区的共享子目录（`{ workspaceId, dirs }`）；首次添加自动锚定该工作区 |
| GET | `/project?cwd=<path>` | cwd 命中的项目：`{ path, dirs, missingDirs }` 或 `null`（无项目配置） |
| GET | `/list?cwd=<path>&path=<abs>` | 列一个项目根目录层级（fence 到项目可写根，越界 403） |
| GET | `/read?cwd=<path>&path=<abs>` | 文本读取，上限 4MB，超出返回 `truncated: true` |
| POST | `/write` | 保存文本（`{ cwd, path, content }`），fence，自动建父目录 |
| GET | `/file?cwd=<path>&path=<abs>` | 原始字节（图片/PDF/二进制）；`&download=1` → attachment disposition |
| POST | `/open-directory` | 用系统文件管理器打开一个文件夹（插件自有路由） |

错误：400 非法输入、403 项目根之外（fence）、404 未知工作区、405 未知方法/路由。

## 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

```sh
dsh plugin --profile web add @luoxunhao/dsh-codex-project
```

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R）即可看到「项目文件夹」tab 和管理工作区入口。client 改动无需重启 DSH；host 改动需重启。

<details>
<summary><b>本地开发</b></summary>

```sh
git clone <repo-url> && cd dsh-codex-project
pnpm install && pnpm build
dsh plugin --profile web add <本仓库绝对路径>
```

也可用 `dev.patch.yml` 挂载（无需 install 进 profile）：

```sh
dsh --profile web --patch <本仓库绝对路径>/dev.patch.yml
```

client 改动浏览器硬刷新即可；host 改动（路由、seam、fs、runner）需重启 `dsh web`。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `Ignored build scripts` | pnpm 拦截构建脚本。在 profile 目录下跑 `pnpm approve-builds --all`。 |
| 报 `minimum release age` | 版本发布不足 24 小时。等 24h 或重跑一次。 |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 profile。 |
| 「项目文件夹」tab 不出现 | better-sidebar 未安装。该 tab 仅在 better-sidebar 安装时注册。 |
| Windows 下终端/runner 异常 | 确认 `@deepseek-ai/dsh-sandbox-windows-acl` 已正确安装（koffi 需构建脚本）。 |

</details>

## 开发

```bash
pnpm typecheck          # 类型检查（tsc --noEmit）
pnpm test               # 单元测试（vitest，12 个文件）
pnpm build              # 构建 lib/（tsc types + tsdown：host ESM + client CJS + runner + fs）
pnpm proto:verify       # 多根 runner 原型实证（Windows ACL，需先 build）
```

**架构约束**：

- client bundle 禁止 value-import 其他插件的运行时符号（纯度门）；与 DSH 源码的集成只走公开/只读 API；
- browser bundle 无 `node:path`——路径运算放 `src/client/paths.ts`；
- 「项目文件夹」tab 通过 `betterSidebar.registerTab` 接入（仅在 better-sidebar 安装时注册），client 侧用结构化再声明消费；
- fence 只改一处：复用 `dirs-api.ts` 的 `fenceFor`，不要另写一份 roots 推导。

## 测试

`tests/`（vitest，browser 组件用 jsdom）：

- `dirs-api.spec.ts` — CRUD + 锚定 + 失效根 + 项目解析 + 目录列表（排序/fence 403/跨盘根）+ 读/写/文件字节与下载 disposition
- `project-tab.spec.tsx` — 无配置回退单根、根行（主/共享/缺失）、懒加载、点击即内联预览、右键菜单
- `file-reference.spec.ts` — @ 引用源注册 / 注入 / 序列化
- `client-apply.spec.tsx` / `client-components.spec.tsx` — 插件形态、菜单注入、管理弹窗
- `fs-fence.spec.ts` / `seam-wiring.spec.ts` — 多根 fence 收窄/隔离/自愈、runner 接线
- `context-injection.spec.ts` — 上下文提醒（文本组成/折叠位置/去重/缺失标注）
- `add-dir.spec.ts` — add-dir 工具（校验/审批/持久化）
- `plugin-shape.spec.ts` — 插件导出形态

新增 API 面（如 `SpacesApi` 加方法）时，记得同步更新各测试里的 fake，否则 typecheck 会因缺方法失败。
