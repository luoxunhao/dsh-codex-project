/**
 * The native DSH right-Sidebar integration (DSH 0.1.6): the 项目文件夹 tree
 * and its per-file 文件预览, registered through the official two-stage path —
 * the type into `ctx.sidebarRightTabs`, the body into the keyed
 * `sidebar.right.pane.tab` seat and the chip title into
 * `sidebar.right.pane.tab.title`, both under the definition's `id`.
 *
 * The plugin consumes those seats structurally (see context.ts): the client
 * bundle's purity gate forbids value-importing another plugin's runtime, so
 * every interaction here is a cordis service method call, and the plugin
 * supplies its own React components.
 *
 * Both kinds are PAGE types (`patterns` omitted): they are opened by kind
 * (`tab.actions.openTab`), never by a `dsh-resource://` address, so the plugin
 * never competes with the product's own file viewers — a file inside the
 * session workspace keeps opening in whatever type already claims it, and the
 * tree hands its rows to the plugin's OWN preview tab (which reads through the
 * plugin's multi-root routes and therefore also reaches cross-drive shared
 * directories the host's workspace fence refuses).
 * @module dsh-codex-project/client/native-sidebar
 */
import { createElement, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SpacesApi } from './api.ts'
import type {
  ClientRuntimeContext,
  NativeTabInfo,
  SessionListFace,
  SidebarRightTabDefinition,
  SidebarRightTabsService,
  SlotsService,
  SidebarTabScope,
} from './context.ts'
import { basename } from './paths.ts'
import { ProjectTab } from './project-tab.tsx'
import { PreviewPane } from './preview-pane.tsx'

/** The 项目文件夹 page type's kind (the value `openTab` names). */
export const PROJECT_KIND = 'codex-project'

/** The 项目文件夹 implementation's identity, and the key its body registers under. */
export const PROJECT_ID = '@luoxunhao/dsh-codex-project'

/** The 文件预览 page type's kind. */
export const FILE_KIND = 'codex-project-file'

/** The 文件预览 implementation's identity, and the key its body registers under. */
export const FILE_ID = '@luoxunhao/dsh-codex-project/file'

/**
 * The `params` a 文件预览 page carries: the absolute file it shows. The
 * plugin's own preview tab is a page without `multiple` (the pane keeps one per
 * kind per pane), so opening a second file NAVIGATES the open one instead of
 * stacking a tab — and `navigation.revision`, which ticks on every navigation
 * whether or not the params changed, is what tells the body to re-read.
 */
export interface FilePreviewParams {
  path: string
}

/**
 * Read the file a 文件预览 page is aimed at out of a tab's `navigation.params`.
 *
 * The page deduplicates per pane, so a second 文件预览 open does not stack a
 * tab — it NAVIGATES the open one, and this is how the body and its chip title
 * learn which file they now show. Anything that is not a non-empty `path`
 * string (an absent params bag, a hand-written one) reads as "not aimed yet".
 * @param params - the tab's current `navigation.params`.
 * @returns the absolute file path, or undefined when the page was never aimed.
 */
export function previewPathOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const path = (params as Partial<FilePreviewParams>).path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** The folder glyph the guide capsule and the chip title draw. */
function FolderGlyph({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  return createElement(IconFolderOpenOutline16, { size, className })
}

/**
 * The 项目文件夹 page type's registry definition.
 *
 * Both definitions below are the SHARED `SidebarRightTabDefinition` face from
 * `context.ts` rather than a local restatement of it — one shape per contract.
 * The params they carry are likewise narrowed at runtime (`previewPathOf`)
 * instead of merged into the upstream `SidebarRightTabParamsMap`: the merge
 * would buy a compile-time check on `openTab(FILE_KIND, { params })` at the
 * cost of a type-only import of the carrier package, against this bundle's rule
 * that every native face is restated structurally so drift stays in one file.
 * Revisit if a second params-carrying kind ever shows up.
 */
export function projectDefinition(): SidebarRightTabDefinition {
  return {
    id: PROJECT_ID,
    kind: PROJECT_KIND,
    priority: 'extension',
    title: () => '项目文件夹',
    guide: [{
      id: 'project',
      order: 45,
      title: () => '项目文件夹',
      description: () => '浏览项目主根与共享目录（可跨盘符）',
      icon: FolderGlyph,
    }],
  }
}

/** The 文件预览 page type's registry definition (hidden from the guide). */
export function fileDefinition(): SidebarRightTabDefinition {
  return {
    id: FILE_ID,
    kind: FILE_KIND,
    priority: 'extension',
    title: () => '文件预览',
  }
}

/**
 * What the native body receives: the framework's session standard props (the
 * active session id, injected by ui-session) plus the slot-level `useTabInfo`
 * hook (declared by ui-sidebar-right's seat for every registration), wrapped
 * with the plugin's own closed-over face.
 */
export interface NativeTabBodyProps {
  /** The session the tab lives in (framework-injected). */
  sessionId: string
  /** The framework-bound reader of the tab record, its navigation and actions. */
  useTabInfo: () => NativeTabInfo
  /** The observable session-list feed, so a late cwd re-renders the body. */
  sessions: SessionListFace | undefined
  /** The plugin's own dirs API (closed over from `apply`). */
  api: SpacesApi
  /** The client runtime context, for the `@` reference insert (closed over). */
  runtimeCtx: ClientRuntimeContext
}

/**
 * Read the tab record this body was bound to.
 *
 * The framework's reader throws while the record is not committed — a session
 * switch, or a tab mid-teardown, where its layout row has already gone. Caught
 * here and reported as "nothing to show yet", because an unguarded throw during
 * render takes the whole right Sidebar down with this body. Safe to catch: the
 * reader's own hooks all run before the throw site, so React sees the same hook
 * order on both paths.
 * @param useTabInfo - the framework-bound reader.
 * @returns the live tab information, or undefined while it is not committed.
 */
function readTabInfo(useTabInfo: () => NativeTabInfo): NativeTabInfo | undefined {
  try {
    return useTabInfo()
  } catch {
    return undefined
  }
}

/**
 * Subscribe to one session's working directory. The projection fills `cwd`
 * asynchronously, so the body must re-render when it arrives; a missing feed
 * (an unusual composition) degrades to a one-shot read with no subscription.
 *
 * `useSyncExternalStore` compares snapshots by identity, so the reader hands
 * React the cwd STRING rather than the list snapshot: a projection that mints
 * a fresh snapshot object per read (a plain store, a test double) would
 * otherwise re-render forever. The subscribe reader is memoized on the feed
 * identity for the same reason — a fresh closure per render resubscribes on
 * every commit.
 * @param sessions - the session-list feed, when the service exposes one.
 * @param sessionId - the session whose cwd the body needs.
 * @returns the cwd, or undefined while the projection is cold.
 */
function useSessionCwd(sessions: SessionListFace | undefined, sessionId: string): string | undefined {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => sessions?.subscribe(listener) ?? (() => {}),
    [sessions],
  )
  const read = useCallback((): string | undefined => {
    try {
      return sessions?.getSnapshot().byId[sessionId]?.cwd
    } catch {
      // A projection that throws while cold reports "no cwd yet", never a crash.
      return undefined
    }
  }, [sessions, sessionId])
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * The page shell carrying a one-line notice, for the states where there is
 * nothing to draw yet (a cold workspace, an un-aimed preview page).
 * @param text - the notice.
 */
function TabNote({ text }: { text: string }): ReactNode {
  return (
    <div className="dsh-cxp-tab" data-dsh-codex-project-tab>
      <div className="dsh-cxp-tab-note">{text}</div>
    </div>
  )
}

/**
 * The 项目文件夹 page body: the multi-root tree for the tab's session.
 * @param props - the framework session props plus the plugin's closed-over face.
 */
export function NativeProjectTab(props: NativeTabBodyProps): ReactNode {
  const { sessionId, useTabInfo, sessions, api, runtimeCtx } = props
  const info = readTabInfo(useTabInfo)
  const cwd = useSessionCwd(sessions, sessionId)
  const scope: SidebarTabScope = {
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
  }
  if (info === undefined || cwd === undefined || cwd === '') {
    return <TabNote text="等待工作区…" />
  }
  const { tab } = info
  // A row hands the file to the plugin's OWN preview page, which reads through
  // the plugin's multi-root routes: cross-drive shared dirs preview fine,
  // unlike the host-fenced native file viewer. The page has no `multiple`, so
  // a second file navigates the open one rather than stacking a tab.
  const openPreview = (path: string): void => {
    const params: FilePreviewParams = { path }
    tab.actions.openTab(FILE_KIND, { params })
  }
  // `ProjectTab` carries the tab shell itself (its own root is the
  // `dsh-cxp-tab` node), so wrapping it again would nest two identical shells.
  return (
    <ProjectTab
      ctx={runtimeCtx}
      api={api}
      scope={scope}
      openPreview={openPreview}
    />
  )
}

/**
 * The 文件预览 page body: the plugin's own preview pane for the file the page
 * currently navigates to (`navigation.params.path`).
 *
 * The pane is keyed on the NAVIGATION, not just the path: `revision` ticks on
 * every navigation whether or not the params changed, so clicking the same file
 * a second time re-reads it (the tree is a live view of a directory the agent
 * is editing) instead of leaving a stale pane on screen. Remounting the whole
 * pane is the sanctioned shape here — see the CodeMirror rules in AGENTS.md §5:
 * the editor host must never be conditionally unmounted INSIDE the pane, but
 * the pane itself is safe to remount per navigation.
 * @param props - the framework session props plus the plugin's closed-over face.
 */
export function NativeFileTab(props: NativeTabBodyProps): ReactNode {
  const { sessionId, useTabInfo, sessions, api } = props
  const info = readTabInfo(useTabInfo)
  const cwd = useSessionCwd(sessions, sessionId)
  if (info === undefined) return <TabNote text="等待工作区…" />
  const navigation = info.tab.navigation
  const path = previewPathOf(navigation?.params)
  if (path === undefined) return <TabNote text="未指定要预览的文件" />
  if (cwd === undefined || cwd === '') return <TabNote text="等待工作区…" />
  return (
    <div className="dsh-cxp-tab" data-dsh-codex-project-tab>
      <PreviewPane key={`${path}#${navigation?.revision ?? 0}`} api={api} cwd={cwd} path={path} />
    </div>
  )
}

/** The 项目文件夹 chip title: the glyph plus the type's label. */
export function NativeProjectTitle(props: { useTabInfo: () => NativeTabInfo }): ReactNode {
  const info = readTabInfo(props.useTabInfo)
  return createElement('span', { className: 'dsh-cxp-native-title' },
    createElement(FolderGlyph, { size: 16 }),
    info?.tab.title ?? '项目文件夹',
  )
}

/** The 文件预览 chip title: the current file's basename (falls back to the captured title). */
export function NativeFileTitle(props: { useTabInfo: () => NativeTabInfo }): ReactNode {
  const info = readTabInfo(props.useTabInfo)
  const path = previewPathOf(info?.tab.navigation?.params)
  return createElement('span', { className: 'dsh-cxp-native-title' },
    path === undefined ? info?.tab.title ?? '文件预览' : basename(path),
  )
}

/** Everything the native registration needs from the plugin's client half. */
export interface NativeSidebarDeps {
  api: SpacesApi
  /** The observable session-list feed the bodies read each cwd from. */
  sessions: SessionListFace | undefined
  /** Close over the runtime ctx so `insertFileReference` keeps working. */
  runtimeCtx: ClientRuntimeContext
}

/**
 * Register both page types into the native right Sidebar.
 *
 * The registration is the documented two-stage path: stage one declares the
 * types, stage two fills the keyed body and title seats. It runs once per
 * arrival of the services (see the `ctx.inject` call in `index.tsx`), and the
 * returned disposer takes every one of those contributions back — so a
 * re-arrival registers afresh rather than stacking.
 * @param deps - the dirs API, the session feed, and the runtime context.
 * @param services - the native services this path was mounted for.
 * @returns a disposer unregistering everything this call registered.
 */
export function registerNativeSidebar(
  deps: NativeSidebarDeps,
  services: { tabs: SidebarRightTabsService; slots: SlotsService },
): () => void {
  const { tabs, slots } = services
  const { api, sessions, runtimeCtx } = deps
  const disposers: Array<() => void> = []

  // Stage one: what each page type IS. The type registry is a plain service
  // and needs no slot declaration to exist.
  disposers.push(tabs.register(projectDefinition()), tabs.register(fileDefinition()))

  const body = (Component: (props: NativeTabBodyProps) => ReactNode) =>
    (props: { sessionId: string; useTabInfo: () => NativeTabInfo }): ReactNode =>
      createElement(Component, { ...props, api, sessions, runtimeCtx })

  // Stage two: the bodies and the chip titles, dispatched on each type's `id`.
  // `slots.inject` waits for the seat's declaration, so plugin load order
  // against ui-sidebar-right does not matter.
  const fillSeat = (name: string, id: string, component: unknown): void => {
    disposers.push(slots.inject(name, () => slots.register({ name, key: id }, component)))
  }
  fillSeat('sidebar.right.pane.tab', PROJECT_ID, body(NativeProjectTab))
  fillSeat('sidebar.right.pane.tab', FILE_ID, body(NativeFileTab))
  fillSeat('sidebar.right.pane.tab.title', PROJECT_ID, NativeProjectTitle)
  fillSeat('sidebar.right.pane.tab.title', FILE_ID, NativeFileTitle)

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}
