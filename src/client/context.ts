/**
 * Client-half Context for dsh-codex-project. The client runtime's Context
 * is a local face: upstream `declare module 'cordis'` augmentations do not
 * reach it, so the plugin declares the services it uses structurally (see
 * DSH-better-sidebar/src/context-types.ts for the full pattern). Only the
 * slices the plugin touches are restated; drift from upstream is contained
 * to this file.
 */

/** One registered workspace row (subset of the wire WorkspaceView). */
export interface ClientWorkspaceView {
  workspaceId: string
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
}

/** The workspace registry snapshot the dialog reads for record identities. */
export interface ClientWorkspaceListState {
  items: readonly ClientWorkspaceView[]
}

/** The workspaces-service face the client bundle consumes (subset of the real surface). */
export interface ClientWorkspacesService {
  /** The workspace registry feed (record main-workspace identities). */
  list: {
    getSnapshot(): ClientWorkspaceListState
    subscribe(fn: () => void): () => void
  }
  /**
   * Register an existing path as a core Workspace (idempotent). Returns the
   * wire `WorkspaceView` — its id field is `workspaceId`.
   */
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** One session scope: the session id plus its working directory. */
export interface SidebarTabScope {
  sessionId: string
  cwd?: string
}

/* --------------------------------------------------------------------------
 * Native DSH right-Sidebar (DSH 0.1.6) structural faces.
 *
 * The client bundle's purity gate forbids value-importing
 * `@deepseek-ai/dsh-client-ui-sidebar-right` (it is not a platform module), so
 * the services the native path uses are restated structurally here — only the
 * slices the plugin touches. Drift from upstream is contained to this file.
 * ------------------------------------------------------------------------ */

/** One tab record, as the seat's `useTabInfo` reader returns it (subset). */
export interface NativeTabRecord {
  /** The kind the tab was opened as — what `openTab` names. */
  kind: string
  /** The title captured when the tab opened (a page navigated later re-titles itself). */
  title: string
}

/** Where a tab was last navigated to: the opener's params plus a counter. */
export interface NativeTabNavigation {
  params?: unknown
  /** Incremented on every navigation to the tab, params changed or not. */
  revision?: number
}

/**
 * The live tab information the framework binds for every tab body and title:
 * the record, where it navigated, and the actions bound to THIS tab's panel
 * and session. Restated to the members the plugin calls — the rest of the
 * upstream shape (sidebar/panel geometry, the abort signal, `openResource`,
 * `close`) has no consumer here, and adding one is what grows this face.
 */
export interface NativeTabInfo {
  tab: NativeTabRecord & {
    navigation?: NativeTabNavigation
    actions: {
      /** Open a page of a registered kind, optionally aimed at params. */
      openTab(kind: string, options?: { params?: unknown }): void
    }
  }
}

/** One guide-card entry of a tab-type definition (the capsule keys on `id`). */
export interface SidebarRightTabGuideEntry {
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: (props: { size?: number; className?: string }) => unknown
}

/**
 * Stage one of a tab type: what the type IS, never a runtime hook. `id` is
 * ALSO the key both native seats contribute under, and `kind` the value
 * `openTab` names. This is the ONE shape — `native-sidebar.tsx` registers
 * against it rather than restating it a second time.
 */
export interface SidebarRightTabDefinition {
  id: string
  kind: string
  /** Each open gets independent content; omitted keeps one page per kind per pane. */
  multiple?: boolean
  /** Resource-address globs; omitted for a page type opened by kind. */
  patterns?: readonly string[]
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: readonly SidebarRightTabGuideEntry[]
}

/**
 * The native right-Sidebar tab-type registry (`ctx.sidebarRightTabs`): stage
 * one of a tab type's registration — what the type IS, never a runtime hook.
 */
export interface SidebarRightTabsService {
  /** Register one tab type for the caller's lifetime; returns its disposer. */
  register(definition: SidebarRightTabDefinition): () => void
}

/**
 * The slot registry face (`ctx.slots`), restated to the two members the
 * native path uses: wait for a slot's declaration, then contribute into it.
 */
export interface SlotsService {
  /**
   * Run `callback` for each declaration lifetime of `key`; the callback
   * returns the registration's disposer (or several).
   */
  inject(key: string, callback: () => (() => void) | ReadonlyArray<() => void>): () => void
  /** Contribute a component to a declared slot. */
  register(
    options: { name: string; key?: string; id?: string; order?: number; label?: string },
    component: unknown,
  ): () => void
}

/** One session row of the client session projection (subset actually consumed). */
export interface ClientSessionSummary {
  /** The session's working directory; absent while the projection is cold. */
  cwd?: string
}

/** The session list snapshot: rows keyed by session id. */
export interface ClientSessionListState {
  byId: Record<string, ClientSessionSummary | undefined>
}

/**
 * The observable session-list feed (`ctx.sessions.list`): the snapshot plus
 * its subscription, so a React consumer can re-render when a session's cwd
 * arrives or changes instead of reading a cold snapshot once.
 */
export interface SessionListFace {
  getSnapshot(): ClientSessionListState
  subscribe(listener: () => void): () => void
}

/**
 * The session registry (`ctx.sessions`): one scope per session, plus the
 * observable list projection each row's cwd comes from.
 */
export interface ClientSessionsService {
  scope(sessionId: string): unknown
  list?: SessionListFace
}

/**
 * The client runtime context face the tab and the `@` source consume: the
 * conversation service (`get('conversation')`) plus the session registry —
 * both reached lazily so a missing service degrades to a logged no-op, never a
 * crash. The session list carries each session's cwd, which the `@` source
 * needs to resolve the project roots its candidates come from.
 *
 * ⚠️ This is NOT the plugin's own `Context`: cordis hands a plugin a proxy that
 * reads `undefined` for every service outside its declared `inject` list, so
 * `ctx.sessions` on the plugin's ctx is absent by construction (and a component
 * that only checks `ctx.sessions?.` then no-ops silently). Whatever reaches a
 * component as a runtime ctx must be SYNTHESIZED from services this plugin
 * actually holds — see the `runtimeCtx` built in `index.tsx`.
 */
export interface ClientRuntimeContext {
  get(service: string): unknown
  sessions: ClientSessionsService
}

/** One reference-chip occurrence in the composer draft (clipboard coordinates). */
export interface DraftOccurrence {
  /** Clipboard offset of the chip's clipboard projection. */
  offset: number
  /** Length of the chip's clipboard projection. */
  length: number
}

/** The composer draft input face (subset of the conversation service). */
export interface DraftInput {
  input: {
    for(sessionScope: unknown): {
      state: { getSnapshot(): {
        /** Clipboard-text projection of the editor document (chips expanded). */
        draft: string
        /** Reference-chip occurrences, in clipboard coordinates. */
        occurrences: readonly DraftOccurrence[]
        /** Input revision (CAS for every slash/input-* edit). */
        draftRev: number
      } }
      setDraft(text: string): void
    }
  }
}

/**
 * One inline file-reference chip the plugin injects into the composer. The
 * draft holds one placeholder per chip; the owner supplies the user-facing
 * projections at insert time (label = the chip text, clipboardText = the
 * copy/persistence form), and a registered source's codec serializes `ref`
 * into the model context on submit. `source` must name a registered source.
 */
export interface FileReferenceInsert {
  source: string
  ref: string
  label: string
  clipboardText: string
  /** Chip glyph: a directory renders as a folder, a file as a file. */
  appearance?: 'file' | 'folder' | 'session'
}

/**
 * A zero-width insertion span in DETECT coordinates (the plane the composer's
 * `slash/input-insert-reference` expects, where each chip counts as one U+FFFC),
 * plus the CAS revision. `start`/`end` are equal (a collapsed span at the true
 * detect end); `draftRev` must be the current input revision or the edit is
 * rejected.
 */
export interface FileReferenceSpan {
  /** Detect offset of the insertion point (must equal `end`). */
  start: number
  /** Detect offset of the insertion point (must equal `start`). */
  end: number
  /** Input revision (CAS). */
  draftRev: number
}

/** The client input-trigger service face (subset actually consumed). */
export interface ClientInputTriggerService {
  registerSource(source: unknown): () => void
}

/** The service reader the `inject` callback is handed for its declared deps. */
export interface InjectedContext {
  get(name: string): unknown
}

/** The client cordis context for this plugin. */
export interface Context {
  workspaces: ClientWorkspacesService
  /** The input-trigger roster, present only when that plugin is installed. */
  inputTriggers?: ClientInputTriggerService
  /** Register a fiber teardown callback (cordis Context face). */
  effect(callback: () => void | (() => void), name?: string): void
  /** Read a service from the reflect store without inject requirement (cordis Context face). */
  get(name: string): unknown
  /** The raw service store (cordis Context face): reads what an `inject`
   *  declaration has not claimed, which is how an optional service is probed. */
  reflect: { get(name: string): unknown }
  /**
   * Mount a child fiber that waits on OPTIONAL services without blocking this
   * one (cordis Context face): the callback runs each time every named service
   * is present and returns its teardown, so a provider that appears after this
   * plugin applied still gets its registrations — and they unwind with it.
   */
  inject(
    deps: readonly string[],
    callback: (ctx: InjectedContext) => void | (() => void),
  ): { readonly dispose: () => Promise<void> }
}

