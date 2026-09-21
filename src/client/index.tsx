/**
 * dsh-codex-project client half: injects the 编辑工作区 entry into the
 * native workspace 「…」 menu (DOM-level, self-healing) and mounts the
 * manage dialog it opens. It ALSO registers the 项目文件夹 tree — a
 * multi-root file tree of the project (main root + shared dirs, cross-drive)
 * with a per-file preview — as two page types of DSH's own right Sidebar
 * (`ctx.sidebarRightTabs` + the keyed `sidebar.right.pane.tab` seats; see
 * `native-sidebar.tsx`), which every web composition ships.
 *
 * The sidebar registration waits on those services through `ctx.inject` rather
 * than reading them once at apply time: whether THIS plugin applies before or
 * after `ui-sidebar-right` is up to the composition order, and a one-shot read
 * at apply would then see the carrier as absent and never come back. (Inside
 * `ui-sidebar-right` itself the registry is provided BEFORE its seats declare,
 * so it is the cross-plugin order that races, not the intra-plugin one.)
 *
 * The DOM-level injection follows the dsh-web-ui family precedent: the
 * workspace menu popup is React-managed native code with no extension
 * point, so the item is injected per popup-open and self-binds its click.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — an
 * external plugin must not take the GUI down.
 */
import type {
  ClientSessionsService,
  Context,
  ClientRuntimeContext,
  SidebarRightTabsService,
  SlotsService,
} from './context.ts'
import { createSpacesApi } from './api.ts'
import { createFileReferenceSource } from './file-reference.ts'
import { mountWorkspaceMenuManageEntry } from './workspace-menu.ts'
import { registerNativeSidebar } from './native-sidebar.tsx'
import { injectStyles } from './styles.ts'

/** Probe for an optional cordis service without going through the proxy. */
function probeService(ctx: Context, name: string): unknown {
  try { return ctx.reflect.get(name) } catch { return undefined }
}

/** Services required before mounting (provided by the client runtime). The
 *  sidebar carrier is OPTIONAL — cordis keeps a fiber pending while a required
 *  service is missing, so `sidebarRightTabs` never appears here; the plugin
 *  waits on it with `ctx.inject` instead. */
export const inject = ['workspaces', 'inputTriggers']

/** Apply claim: a duplicated client injection must not mount a second entry. */
let claimed = false

/**
 * Client plugin body.
 * @param ctx - the client cordis context (workspaces).
 */
export function apply(ctx: Context): void {
  if (claimed) return
  claimed = true
  ctx.effect(() => () => { claimed = false }, 'dsh-codex-project: apply claim')

  const api = createSpacesApi()
  const disposers: Array<() => void> = []
  const mount = (name: string, install: () => (() => void) | undefined): void => {
    try {
      const dispose = install()
      if (dispose !== undefined) disposers.push(dispose)
    } catch (error) {
      console.error(`[dsh-codex-project] ${name} mount failed:`, error)
    }
  }

  /** Resolve one session's cwd for the `@` source (the anchor of the project:
   *  shared dirs outside it are reachable from here, while core discovery is
   *  rooted at the cwd alone). Probed PER CALL, not hoisted to apply: the
   *  plugin's own ctx proxy does not expose `ctx.sessions`, so the reflect
   *  store is the only read, and a registry that arrives after apply must still
   *  get used rather than being cached away as absent. */
  const cwdFor = (sessionId: string): string | undefined => {
    try {
      const sessions = probeService(ctx, 'sessions') as ClientSessionsService | undefined
      return sessions?.list?.getSnapshot().byId[sessionId]?.cwd
    } catch {
      return undefined
    }
  }

  mount('styles', () => injectStyles())
  if (ctx.inputTriggers !== undefined) {
    mount('file-reference source', () => ctx.inputTriggers!.registerSource(
      createFileReferenceSource(api, { cwdFor }),
    ))
  }
  mount('workspace … menu entry', () => mountWorkspaceMenuManageEntry({
    workspaces: ctx.workspaces,
    api,
  }))

  // --- The 项目文件夹 / 文件预览 page types, into DSH's own right Sidebar. ---
  // Waited on rather than probed: this plugin can apply before ui-sidebar-right
  // does, and a one-shot read at apply would then miss the carrier for good.
  // `sessions` rides along because both page bodies anchor their reads on the
  // session cwd — without it there is nothing to render, and re-provisioning it
  // re-runs this callback, which is what keeps a late registry from sticking.
  mount('native right-Sidebar tabs', () => {
    const fiber = ctx.inject(['sidebarRightTabs', 'slots', 'sessions'], (injected) => {
      const tabs = injected.get('sidebarRightTabs') as SidebarRightTabsService | undefined
      const slots = injected.get('slots') as SlotsService | undefined
      const sessions = injected.get('sessions') as ClientSessionsService | undefined
      if (tabs === undefined || slots === undefined || sessions === undefined) return
      // Synthesized, never `ctx` itself: the plugin's context proxy hides the
      // host's session registry, so passing `ctx` down made the tree's
      // 「引用到对话」 return silently (see ClientRuntimeContext).
      const runtimeCtx: ClientRuntimeContext = {
        get: (name: string): unknown => injected.get(name),
        sessions,
      }
      return registerNativeSidebar(
        { api, sessions: sessions.list, runtimeCtx },
        { tabs, slots },
      )
    })
    return () => { void fiber.dispose() }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-codex-project: ui mounts')
}
