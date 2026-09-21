/**
 * Native right-Sidebar registration: the plugin claims the two page types and
 * fills the keyed `sidebar.right.pane.tab` / `.pane.tab.title` seats under
 * each type's `id`, through the same public two-stage path the product's own
 * tab types use. The registry and the seats are recorders, because what matters
 * here is what was handed to them and that a plugin unload takes every
 * registration back.
 *
 * The carrier is WAITED on with `ctx.inject`, not probed at apply time, so the
 * double below reproduces cordis' own arrival semantics: the callback runs once
 * every named service exists, and services that show up later re-run it.
 */

// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** What `NativeProjectTab` handed the tree, captured instead of rendered. */
const hoisted = vi.hoisted(() => ({
  props: [] as Array<{
    ctx: { get(name: string): unknown; sessions?: { scope(id: string): unknown } }
    scope: { cwd?: string }
    openPreview: (path: string) => void
    openEditor: (path: string) => void
  }>,
}))

vi.mock('../src/client/project-tab.tsx', () => ({
  ProjectTab: (props: {
    ctx: { get(name: string): unknown; sessions?: { scope(id: string): unknown } }
    scope: { cwd?: string }
    openPreview: (path: string) => void
    openEditor: (path: string) => void
  }) => {
    hoisted.props.push(props)
    return null
  },
}))

import { apply, inject } from '../src/client/index.tsx'
import type { SpacesApi } from '../src/client/api.ts'
import type { Context, NativeTabInfo } from '../src/client/context.ts'
import {
  FILE_ID,
  FILE_KIND,
  PROJECT_ID,
  PROJECT_KIND,
  NativeFileTab,
  NativeFileTitle,
  NativeProjectTab,
  fileDefinition,
  previewPathOf,
  previewModeOf,
  projectDefinition,
} from '../src/client/native-sidebar.tsx'

/** One recorder entry: what the seat was handed, plus the component. */
interface Recorded {
  name: string
  key?: string
  component: unknown
}

/** A cordis-like client context double, carrying the native sidebar services. */
function harness(options: { withSidebar?: boolean } = {}) {
  const recorded: Recorded[] = []
  const registeredTypes: Array<{ id: string; kind: string }> = []
  /** The session scope the tree's 「引用到对话」 has to reach, and the composer
   *  service it emits the insert through. Both must arrive on the runtime ctx
   *  the plugin SYNTHESIZES — the plugin's own ctx proxy hides `ctx.sessions`. */
  const actx = { emit: vi.fn() }
  const conversation = { input: { for: () => undefined } }
  const sessions = {
    scope: () => actx,
    list: {
      getSnapshot: () => ({ byId: { s1: { cwd: 'E:\\proj' } } }),
      subscribe: () => () => {},
    },
  }
  const services: Record<string, unknown> = { sessions, conversation }

  const slots = {
    // The real inject waits for a declaration and runs once per declaration
    // lifetime; an already-declared slot runs the callback synchronously.
    inject: (_key: string, callback: () => (() => void) | ReadonlyArray<() => void>) => {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
        else for (const one of dispose) one()
      }
    },
    register: (opts: { name: string; key?: string }, component: unknown) => {
      const entry: Recorded = { name: opts.name, key: opts.key, component }
      recorded.push(entry)
      return () => { recorded.splice(recorded.indexOf(entry), 1) }
    },
  }
  const sidebarRightTabs = {
    register: (definition: { id: string; kind: string }) => {
      registeredTypes.push(definition)
      return () => { registeredTypes.splice(registeredTypes.indexOf(definition), 1) }
    },
  }
  if (options.withSidebar !== false) {
    services.slots = slots
    services.sidebarRightTabs = sidebarRightTabs
  }

  const disposers: Array<() => void | (() => void)> = []
  /** Child fibers opened by `ctx.inject`, with the disposer their last run returned. */
  const fibers: Array<{
    deps: readonly string[]
    callback: (ctx: { get(name: string): unknown }) => void | (() => void)
    dispose?: () => void
  }> = []

  /** Run a fiber's callback when (and as often as) its deps are all present. */
  const runFiber = (fiber: (typeof fibers)[number]): void => {
    if (!fiber.deps.every(name => services[name] !== undefined)) return
    fiber.dispose?.()
    const dispose = fiber.callback({ get: (name: string) => services[name] })
    fiber.dispose = () => {
      const result = dispose?.()
      if (typeof result === 'function') (result as () => void)()
    }
  }

  const target: Record<string, unknown> = {
    workspaces: {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      create: async () => ({ workspaceId: 'w1' }),
    },
    // The plugin probes optional services through the reflect layer (cordis'
    // own escape hatch around the inject requirement).
    reflect: { get: (name: string) => services[name] },
    // cordis' ctx.effect runs the body IMMEDIATELY and collects the disposer it
    // returns; the harness mirrors that, so registrations really happen.
    effect: (callback: () => void | (() => void)) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: (name: string) => services[name],
    inject: (deps: readonly string[], callback: (ctx: { get(name: string): unknown }) => void | (() => void)) => {
      const fiber: (typeof fibers)[number] = { deps, callback }
      fibers.push(fiber)
      runFiber(fiber)
      return {
        dispose: async (): Promise<void> => {
          fiber.dispose?.()
          fibers.splice(fibers.indexOf(fiber), 1)
        },
      }
    },
  }
  // The cordis proxy refuses undeclared service access, so the harness mirrors
  // it: anything outside the inject list and the surfaces above reads undefined.
  const allowed = new Set([...inject, 'effect', 'get', 'inject', 'reflect'])
  const ctx = new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === 'string' && !allowed.has(prop) && !(prop in inner)) return undefined
      return Reflect.get(inner, prop)
    },
  }) as unknown as Context

  /** Provide the sidebar carrier late, as a slower-loading provider would. */
  const deliver = (): void => {
    services.slots = slots
    services.sidebarRightTabs = sidebarRightTabs
    for (const fiber of fibers) runFiber(fiber)
  }

  /** Tear every fiber and effect down, the way the client runtime unloads. */
  const unload = (): void => {
    for (const fiber of fibers.splice(0)) fiber.dispose?.()
    for (const dispose of disposers.splice(0)) {
      const result = dispose()
      if (typeof result === 'function') (result as () => void)()
    }
  }

  return { ctx, recorded, registeredTypes, deliver, unload, actx, conversation, services }
}

/**
 * The plugin's `apply` claim is module-level state (a duplicated client
 * injection must not mount a second entry), and unloading is what releases it.
 * Every test therefore tears its harness down, so the next `apply` runs.
 */
let live: ReturnType<typeof harness> | undefined

describe('native right-Sidebar registration', () => {
  afterEach(() => {
    if (live !== undefined) live.unload()
    live = undefined
    document.body.innerHTML = ''
    hoisted.props.length = 0
  })

  /** Build a harness and apply the plugin into it. */
  function boot(options: { withSidebar?: boolean } = {}): ReturnType<typeof harness> {
    const bench = harness(options)
    live = bench
    apply(bench.ctx)
    return bench
  }

  it('defines both kinds as page types at the extension band', () => {
    const project = projectDefinition()
    expect([project.id, project.kind, project.priority]).toEqual([PROJECT_ID, PROJECT_KIND, 'extension'])
    // A page type names no patterns: it is opened by kind, so the plugin never
    // competes with the product's own file viewers.
    expect(project.patterns).toBeUndefined()
    // 0.1.6 requires a stable guide-entry id, because the capsule keys on it.
    expect(project.guide?.map(entry => [entry.id, entry.title()])).toEqual([['project', '项目文件夹']])
    const file = fileDefinition()
    expect([file.id, file.kind]).toEqual([FILE_ID, FILE_KIND])
    expect(file.patterns).toBeUndefined()
    expect(file.guide).toBeUndefined()
  })

  it('registers both types and fills the body and title seats under each id', () => {
    const bench = boot()

    expect(bench.registeredTypes.map(t => t.kind).sort()).toEqual([FILE_KIND, PROJECT_KIND].sort())
    expect(bench.recorded.map(entry => [entry.name, entry.key])).toEqual([
      ['sidebar.right.pane.tab', PROJECT_ID],
      ['sidebar.right.pane.tab', FILE_ID],
      ['sidebar.right.pane.tab.title', PROJECT_ID],
      ['sidebar.right.pane.tab.title', FILE_ID],
    ])
    // Every seat carries a component; nothing was registered empty.
    for (const entry of bench.recorded) expect(entry.component).toBeTruthy()
  })

  it('registers once the sidebar carrier arrives AFTER apply', () => {
    // The native seat declares itself before `sidebarRightTabs` is provided, so
    // a one-shot probe of the carrier at apply could miss it permanently.
    const bench = boot({ withSidebar: false })
    expect(bench.recorded).toEqual([])
    expect(bench.registeredTypes).toEqual([])

    bench.deliver()
    expect(bench.registeredTypes.map(t => t.kind).sort()).toEqual([FILE_KIND, PROJECT_KIND].sort())
    expect(bench.recorded).toHaveLength(4)
  })

  it('takes every registration back when the plugin unloads', () => {
    const bench = boot()
    expect(bench.recorded).toHaveLength(4)
    bench.unload()
    expect(bench.recorded).toEqual([])
    expect(bench.registeredTypes).toEqual([])
  })

  it('mounts nothing sidebar-shaped in a composition without the native sidebar', () => {
    const bench = boot({ withSidebar: false })
    expect(bench.recorded).toEqual([])
    expect(bench.registeredTypes).toEqual([])
  })

  it('hands the tree a runtime ctx that really reaches the session and the composer', async () => {
    // The plugin's own ctx is a cordis proxy that reads `undefined` for any
    // service outside its declared inject list — `ctx.sessions` among them. Hand
    // THAT down and insertFileReference bails on the missing scope, so the
    // tree's 「引用到对话」 is a silent no-op with nothing in the log. What the
    // components receive must be synthesized from services held for real.
    const bench = boot()
    const entry = bench.recorded
      .find(one => one.name === 'sidebar.right.pane.tab' && one.key === PROJECT_ID)
    expect(entry, 'the 项目文件夹 body was contributed to its seat').toBeTruthy()
    const Body = entry!.component as (props: {
      sessionId: string
      useTabInfo: () => NativeTabInfo
    }) => ReactNode
    await render(createElement(Body, {
      sessionId: 's1',
      useTabInfo: tabInfoFor(PROJECT_KIND, undefined, '项目文件夹'),
    }))
    const ctx = hoisted.props.at(-1)!.ctx
    expect(ctx.sessions?.scope('s1')).toBe(bench.actx)
    expect(ctx.get('conversation')).toBe(bench.conversation)
  })
})

/** Render one node with effects flushed, returning the container. */
async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => {})
  return container
}

/**
 * A tab-info reader for one tab kind, optionally navigated at a file.
 *
 * The record is minted ONCE and returned by reference: the body calls the reader
 * on every render, and the `openTab` spy a test asserts on has to be the very
 * one the body reached. A per-call object would hand each render a fresh spy.
 * `navigate` re-aims that same record the way the framework does in place, so a
 * test can drive a re-navigation (same file, higher revision) through it.
 */
function tabInfoFor(kind: string, params?: unknown, title = '文件预览'): TabInfoReader {
  const info: NativeTabInfo = {
    tab: {
      kind,
      title,
      navigation: { ...(params === undefined ? {} : { params }), revision: 1 },
      actions: { openTab: vi.fn(), openResource: vi.fn() },
    },
  }
  const read = (() => info) as TabInfoReader
  read.navigate = (next: unknown, revision: number): void => {
    info.tab.navigation = { params: next, revision }
  }
  return read
}

/** The reader plus the in-place navigation a test can drive. */
interface TabInfoReader {
  (): NativeTabInfo
  navigate: (params: unknown, revision: number) => void
}

/** The props the sidebar framework binds into one page body. */
function bodyProps(useTabInfo: () => NativeTabInfo) {
  return {
    sessionId: 's1',
    useTabInfo,
    sessions: { getSnapshot: () => ({ byId: { s1: { cwd: 'E:\\proj' } } }), subscribe: () => () => {} },
    api: {} as never,
    runtimeCtx: {} as never,
  }
}

describe('项目文件夹 page body', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    hoisted.props.length = 0
  })

  it('hands a readable row to the HOST own viewer as a session file address', async () => {
    // The body's only navigation channel is the record it was bound to, so the
    // open lands in this tab's panel and session — a service-level open would
    // have neither. The Host read behind that address is not confined to the
    // Session root, which is why a shared directory previews here too.
    const useTabInfo = tabInfoFor(PROJECT_KIND, undefined, '项目文件夹')
    await render(createElement(NativeProjectTab, bodyProps(useTabInfo)))
    const props = hoisted.props.at(-1)
    expect(props?.scope).toEqual({ sessionId: 's1', cwd: 'E:\\proj' })

    props?.openPreview('E:\\shared\\notes.md')
    expect(useTabInfo().tab.actions.openResource).toHaveBeenCalledWith(
      'dsh-resource://file/session/s1/E:/shared/notes.md',
    )
    expect(useTabInfo().tab.actions.openTab).not.toHaveBeenCalled()

    // Per-segment encoding: the drive colon stays literal (the grammar keeps it
    // there), everything the address reserves for itself does not.
    props?.openPreview('C:\\tmp\\第 1 版#draft?.pdf')
    expect(useTabInfo().tab.actions.openResource).toHaveBeenLastCalledWith(
      'dsh-resource://file/session/s1/C:/tmp/%E7%AC%AC%201%20%E7%89%88%23draft%3F.pdf',
    )
  })

  it('keeps a name with no extension on the plugin page, where it can be downloaded', async () => {
    // The host viewer classifies by extension; with none it reports the file as
    // unviewable and offers nothing else, while the plugin's own pane answers
    // with a download link. So the unclassifiable name never travels as a
    // resource address.
    const useTabInfo = tabInfoFor(PROJECT_KIND, undefined, '项目文件夹')
    await render(createElement(NativeProjectTab, bodyProps(useTabInfo)))
    const props = hoisted.props.at(-1)

    props?.openPreview('E:\\shared\\LICENSE')
    expect(useTabInfo().tab.actions.openResource).not.toHaveBeenCalled()
    expect(useTabInfo().tab.actions.openTab).toHaveBeenCalledWith(FILE_KIND, {
      params: { path: 'E:\\shared\\LICENSE' },
    })
  })

  it('opens 编辑 on the plugin page, aimed straight at the editor', async () => {
    const useTabInfo = tabInfoFor(PROJECT_KIND, undefined, '项目文件夹')
    await render(createElement(NativeProjectTab, bodyProps(useTabInfo)))
    const props = hoisted.props.at(-1)

    props?.openEditor('E:\\shared\\notes.md')
    expect(useTabInfo().tab.actions.openResource).not.toHaveBeenCalled()
    expect(useTabInfo().tab.actions.openTab).toHaveBeenCalledWith(FILE_KIND, {
      params: { path: 'E:\\shared\\notes.md', mode: 'edit' },
    })
  })

  it('holds its shape while the framework reports the tab as not committed', async () => {
    // The framework's reader THROWS rather than returning nothing while the
    // record is missing (a session switch, a tab mid-teardown). An unguarded
    // throw during render takes the whole right Sidebar down with this body.
    const useTabInfo = (): NativeTabInfo => {
      throw new Error('sidebarRight: tab "t1" is not committed in session "s1"')
    }
    const container = await render(createElement(NativeProjectTab, bodyProps(useTabInfo)))
    expect(container.textContent).toContain('等待工作区…')
    expect(hoisted.props).toEqual([])
  })
})

/** A dirs API that only ever answers a markdown read, recording each call. */
function previewApi(content: string): { api: SpacesApi; reads: Array<{ cwd: string; path: string }> } {
  const reads: Array<{ cwd: string; path: string }> = []
  const api = {
    readFile: async (cwd: string, path: string) => {
      reads.push({ cwd, path })
      return { content, truncated: false }
    },
    fileUrl: (cwd: string, path: string) => `dsh-fake://file${path}`,
    downloadUrl: (cwd: string, path: string) => `dsh-fake://download${path}`,
  } as unknown as SpacesApi
  return { api, reads }
}

describe('文件预览 page navigation', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the file off navigation.params, and nothing off a blank one', () => {
    expect(previewPathOf({ path: 'E:\\proj\\a.md' })).toBe('E:\\proj\\a.md')
    expect(previewPathOf({ path: '' })).toBeUndefined()
    expect(previewPathOf({ path: 42 })).toBeUndefined()
    expect(previewPathOf(undefined)).toBeUndefined()
    expect(previewPathOf('E:\\proj\\a.md')).toBeUndefined()
    expect(previewPathOf(null)).toBeUndefined()
  })

  it('reads the aimed mode, and keeps the default when the params say nothing', () => {
    expect(previewModeOf({ path: 'E:\\a.md', mode: 'edit' })).toBe('edit')
    expect(previewModeOf({ path: 'E:\\a.md' })).toBeUndefined()
    expect(previewModeOf({ path: 'E:\\a.md', mode: 'preview' })).toBeUndefined()
    expect(previewModeOf({ path: 42 })).toBeUndefined()
    expect(previewModeOf(undefined)).toBeUndefined()
  })

  it('titles the chip with the current file name, not the captured one', async () => {
    // The page deduplicates per pane, so the chip must follow the navigation
    // rather than the title captured when the tab first opened.
    const container = await render(createElement(NativeFileTitle, { useTabInfo: tabInfoFor(FILE_KIND, { path: 'E:\\proj\\deep\\notes.md' }) }))
    expect(container.textContent).toContain('notes.md')
    expect(container.textContent).not.toContain('文件预览')
  })

  it('falls back to the captured title when the page was never aimed at a file', async () => {
    const container = await render(createElement(NativeFileTitle, { useTabInfo: tabInfoFor(FILE_KIND) }))
    expect(container.textContent).toContain('文件预览')
  })

  it('asks for a file when the page carries none, instead of rendering an empty pane', async () => {
    const container = await render(createElement(NativeFileTab, bodyProps(tabInfoFor(FILE_KIND))))
    expect(container.textContent).toContain('未指定要预览的文件')
  })

  it('waits for the workspace while the session projection is still cold', async () => {
    const container = await render(createElement(NativeFileTab, {
      ...bodyProps(tabInfoFor(FILE_KIND, { path: 'E:\\proj\\a.md' })),
      sessions: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    }))
    expect(container.textContent).toContain('等待工作区…')
  })

  it('reads the navigated file through the plugin API, anchored at the session cwd', async () => {
    // The page carries the file, the session carries the cwd, and this pane is
    // the one that WRITES back — so the read goes through `api` (cwd, path),
    // not the host file resource the viewer uses.
    const { api, reads } = previewApi('# Title\n\nsome *text*')
    const container = await render(createElement(NativeFileTab, {
      ...bodyProps(tabInfoFor(FILE_KIND, { path: 'E:\\proj\\notes.md' })),
      api,
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(reads).toEqual([{ cwd: 'E:\\proj', path: 'E:\\proj\\notes.md' }])
    const markdown = container.querySelector('.dsh-cxp-preview-markdown')
    expect(markdown, 'markdown preview host is present').not.toBeNull()
    expect(markdown!.querySelector('h1')?.textContent).toBe('Title')
    // Default mode is the rendered preview, so the editor host stays mounted
    // but hidden (AGENTS.md §5: unmounting it would leave a blank editor).
    expect(container.querySelector('.dsh-cxp-preview-cm')?.hasAttribute('hidden')).toBe(true)
  })

  it('opens an edit-aimed page straight in the editor', async () => {
    // The tree's 「编辑」 is the reason this page still exists: the host viewer
    // is read-only. `mode: 'edit'` must skip the markdown preview.
    const { api } = previewApi('# Title\n\nsome *text*')
    const container = await render(createElement(NativeFileTab, {
      ...bodyProps(tabInfoFor(FILE_KIND, { path: 'E:\\proj\\notes.md', mode: 'edit' })),
      api,
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.querySelector('.dsh-cxp-preview-cm')?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('.dsh-cxp-preview-markdown')).toBeNull()
  })

  it('re-reads the SAME file when the page is navigated to it again', async () => {
    // The preview page declares no `multiple`, so a second open navigates the
    // tab that is already there instead of stacking one — and the framework
    // marks that with a bumped `navigation.revision` even when the params did
    // not change. Ignoring the revision left a stale pane on a tree whose files
    // the agent keeps rewriting.
    const { api, reads } = previewApi('# Title')
    const useTabInfo = tabInfoFor(FILE_KIND, { path: 'E:\\proj\\notes.md' })
    const props = { ...bodyProps(useTabInfo), api }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const paint = async (): Promise<void> => {
      await act(async () => { root.render(createElement(NativeFileTab, props)) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    await paint()
    expect(reads, 'the first navigation reads once').toHaveLength(1)

    useTabInfo.navigate({ path: 'E:\\proj\\notes.md' }, 2)
    await paint()
    expect(reads, 'a re-navigation to the same file re-reads it').toHaveLength(2)
    root.unmount()
    container.remove()
  })
})
