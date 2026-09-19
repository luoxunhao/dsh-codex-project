/**
 * 项目文件夹 tab tests. Project resolution drives the tree's empty/single-root
 * state, root rows (main + shared + missing), lazy per-dir listing on expand,
 * opening a file into its own preview tab (openPreview), the right-click 引用到
 * 对话 (file / directory) menu action, the directory/file context-menu contents,
 * and error surfacing. The preview page itself is covered in
 * `native-sidebar.spec.tsx`.
 */

// @vitest-environment jsdom

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectEntry, ProjectListing, ProjectView, SpacesApi } from '../src/client/api.ts'
import type { ClientRuntimeContext } from '../src/client/context.ts'
import { ProjectTab } from '../src/client/project-tab.tsx'

const ROOT_A = 'E:\\proj'
const ROOT_B = 'D:\\shared'
const ROOT_MISSING = 'E:\\gone'

const PROJECT: ProjectView = {
  workspaceId: 'w1',
  path: ROOT_A,
  dirs: [ROOT_B],
  missingDirs: [ROOT_MISSING],
}

/** A fake SpacesApi around a project + per-dir listings, recording calls. */
function fakeApi(project: ProjectView | null, listings: Record<string, ProjectListing> = {}): {
  api: SpacesApi
  openedDirs: string[]
  listed: Array<{ cwd: string; path: string }>
  read: Array<{ cwd: string; path: string }>
  searches: string[]
} {
  const openedDirs: string[] = []
  const listed: Array<{ cwd: string; path: string }> = []
  const read: Array<{ cwd: string; path: string }> = []
  const searches: string[] = []
  return {
    openedDirs,
    listed,
    read,
    searches,
    api: {
      list: async () => ({}),
      getDirs: async () => [],
      setDirs: async (_id, dirs) => [...dirs],
      openDirectory: async (path) => { openedDirs.push(path) },
      pickRoots: async () => [{ name: 'E:\\', path: 'E:\\' }],
      pickList: async (path) => ({ path, parent: null, home: 'C:\\Users\\me', dirs: [] }),
      project: async () => project,
      listDir: async (cwd, path) => {
        listed.push({ cwd, path })
        return listings[path] ?? { path, entries: [], truncated: false }
      },
      readFile: async (cwd, path) => {
        read.push({ cwd, path })
        return { content: '# hello', truncated: false }
      },
      searchProject: async (_cwd, query) => {
        searches.push(query)
        return query === 'readme'
          ? [{ path: `${ROOT_A}\\readme.md`, name: 'readme.md' }]
          : []
      },
      upload: async () => 0,
      writeFile: async () => {},
      fileUrl: (_cwd, path) => `/file?path=${encodeURIComponent(path)}`,
      downloadUrl: (_cwd, path) => `/file?path=${encodeURIComponent(path)}&download=1`,
    },
  }
}

const scope = { sessionId: 's1', cwd: ROOT_A }

/** A fake client runtime ctx recording dispatched file-reference chips. */
function fakeCtx(): { ctx: ClientRuntimeContext; chips: Array<{ ref: string; label: string }> } {
  const chips: Array<{ ref: string; label: string }> = []
  const scopeOf: Record<string, unknown> = {}
  const ctx: ClientRuntimeContext = {
    get: (service) => service === 'conversation'
      ? {
          input: {
            for: (_actx: unknown) => ({
              state: { getSnapshot: () => ({ draft: '', draftRev: 0 }) },
              setDraft: (_text: string) => {},
            }),
          },
        }
      : undefined,
    sessions: {
      scope: (sessionId) => {
        const actx = scopeOf[sessionId] ??= {
          sessionId,
          emit: (_event: string, payload: unknown) => {
            const { reference } = payload as { reference: { ref: string; label: string } }
            chips.push({ ref: reference.ref, label: reference.label })
          },
        }
        return actx
      },
    },
  }
  return { ctx, chips }
}

/** Render the tree tab and return the mounted `[data-dsh-codex-project-tab]`
 *  node. Records which files were opened into the preview tab. */
const mounted: Array<{ root: Root; container: HTMLElement }> = []
async function renderTab(api: SpacesApi, ctx: ClientRuntimeContext):
  Promise<{ tab: HTMLElement; opened: string[] }> {
  const opened: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(ProjectTab, {
      ctx,
      api,
      scope,
      openPreview: (path) => { opened.push(path) },
    }))
  })
  await act(async () => {})
  mounted.push({ root, container })
  const tab = container.querySelector<HTMLElement>('[data-dsh-codex-project-tab]')
  expect(tab).toBeDefined()
  return { tab: tab!, opened }
}

/** Find a tree row whose text content includes `text`. */
function rowByText(tab: HTMLElement, text: string): HTMLElement {
  const row = Array.from(tab.querySelectorAll<HTMLElement>('[data-is-dir], [data-is-file], [data-is-missing]'))
    .find(candidate => candidate.textContent?.includes(text))
  expect(row, `row containing "${text}"`).toBeDefined()
  return row!
}

/** Click an open context-menu item by its label text (the menu is portaled to body). */
async function clickMenu(label: string): Promise<void> {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menu"] button'))
    .find(candidate => candidate.textContent?.trim() === label)
  expect(item, `menu item "${label}"`).toBeDefined()
  await act(async () => {
    item!.click()
  })
}

describe('ProjectTab', () => {
  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount() })
      container.remove()
    }
    document.body.innerHTML = ''
  })

  it('shows the session cwd as a single root when no project is configured', async () => {
    const fake = fakeApi(null)
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    expect(tab.textContent).not.toContain('没有项目共享配置')
    expect(tab.textContent).toContain('proj')
  })

  it('renders the main root, shared dir, and a missing-dir flag', async () => {
    const fake = fakeApi(PROJECT)
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    expect(tab.textContent).toContain('proj (主)')
    expect(tab.textContent).toContain('shared')
    expect(tab.textContent).toContain('(⚠ directory missing)')
    expect(rowByText(tab, '(⚠ directory missing)').hasAttribute('data-is-missing')).toBe(true)
  })

  it('loads a directory level lazily on expand', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'src', path: `${ROOT_A}\\src`, isDir: true, hidden: false, isSymlink: false, broken: false },
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fake.listed).toEqual([{ cwd: ROOT_A, path: ROOT_A }])
    expect(tab.textContent).toContain('src')
    expect(tab.textContent).toContain('readme.md')
  })

  it('the refresh toolbar button reloads an already-expanded directory', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    // Expand the main root → one listDir call.
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fake.listed).toEqual([{ cwd: ROOT_A, path: ROOT_A }])
    // Click the refresh button in the toolbar → the still-open level is re-fetched.
    const refreshBtn = Array.from(tab.querySelectorAll<HTMLButtonElement>('.dsh-cxp-files-toolbar button'))
      .find(b => b.title === '刷新')!
    await act(async () => {
      refreshBtn.click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fake.listed).toEqual([
      { cwd: ROOT_A, path: ROOT_A },
      { cwd: ROOT_A, path: ROOT_A },
    ])
    expect(tab.textContent).toContain('readme.md')
  })

  it('opens a file into its own preview tab on click (no inline preview)', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const { tab, opened } = await renderTab(fake.api, fakeCtx().ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      rowByText(tab, 'readme.md').click()
    })
    // The tree itself does not fetch the file's content — it hands the path to
    // the preview tab via openPreview.
    expect(fake.read).toHaveLength(0)
    expect(opened).toEqual([`${ROOT_A}\\readme.md`])
    // No inline preview chrome lives in the tree-only tab.
    expect(tab.querySelector('.dsh-cxp-preview-filename')).toBeNull()
  })

  it('does not render an inline preview pane or path-jump preview box', async () => {
    const fake = fakeApi(PROJECT)
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    expect(tab.querySelector('.dsh-cxp-preview-pane')).toBeNull()
    expect(tab.querySelector('.dsh-cxp-tab-path-input')).toBeNull()
  })

  it('renders a Files-style toolbar (no "项目文件夹" title; search + refresh + upload)', async () => {
    const fake = fakeApi(PROJECT)
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    // No literal title in the tab content anymore.
    expect(tab.textContent).not.toContain('项目文件夹')
    // Toolbar controls are present.
    expect(tab.querySelector('.dsh-cxp-files-search-input')).not.toBeNull()
    const toolbar = tab.querySelector('.dsh-cxp-files-toolbar')!
    const buttons = Array.from(toolbar.querySelectorAll('button')).map(b => b.title)
    expect(buttons).toEqual(expect.arrayContaining(['刷新', '上传文件', '上传文件夹']))
  })

  it('file rows use a document icon, not a hashtag code glyph', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const fileRow = rowByText(tab, 'readme.md')
    // The file's leading glyph is an SVG document icon, never a '#/hash glyph.
    expect(fileRow.querySelector('svg')).not.toBeNull()
    expect(fileRow.textContent!.replace('@', '')).toContain('readme.md')
  })

  it('runs a debounced project search from the toolbar and shows results', async () => {
    const fake = fakeApi(PROJECT)
    const { tab, opened } = await renderTab(fake.api, fakeCtx().ctx)
    const input = tab.querySelector<HTMLInputElement>('.dsh-cxp-files-search-input')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, 'readme')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Allow the 250ms debounce + search request to settle.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await act(async () => {})
    expect(fake.searches).toEqual(['readme'])
    const resultRow = Array.from(tab.querySelectorAll('.dsh-cxp-files-search-row'))
      .find(row => row.textContent?.includes('readme.md'))
    expect(resultRow).toBeDefined()
    await act(async () => {
      resultRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(opened).toEqual([`${ROOT_A}\\readme.md`])
  })

  it('references a file in chat via the right-click 引用到对话 menu item', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const runtime = fakeCtx()
    const { tab } = await renderTab(fake.api, runtime.ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      rowByText(tab, 'readme.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    // The hover-@ button is gone; the row carries no trailing @ affordance.
    expect(rowByText(tab, 'readme.md').querySelector('.dsh-cxp-row-ref')).toBeNull()
    await clickMenu('引用到对话')
    expect(runtime.chips).toEqual([{ ref: `${ROOT_A}\\readme.md`, label: 'readme.md' }])
  })

  it('references a directory via the right-click 引用到对话 menu item', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'src', path: `${ROOT_A}\\src`, isDir: true, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const runtime = fakeCtx()
    const { tab } = await renderTab(fake.api, runtime.ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      rowByText(tab, 'src').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    await clickMenu('引用到对话')
    expect(runtime.chips).toEqual([{ ref: `E:/proj/src/`, label: 'src/' }])
  })

  it('directory context menu: 引用到对话 + 用文件管理器打开 + 上传到此处, no 下载', async () => {
    const fake = fakeApi(PROJECT)
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const text = tab.ownerDocument.body.textContent ?? ''
    expect(text).toContain('引用到对话')
    expect(text).toContain('用文件管理器打开')
    expect(text).toContain('上传到此处')
    expect(text).not.toContain('下载')
  })

  it('file context menu: 引用到对话 + 下载 present, no 上传到此处', async () => {
    const listing: ProjectListing = {
      path: ROOT_A,
      entries: [
        { name: 'readme.md', path: `${ROOT_A}\\readme.md`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    }
    const fake = fakeApi(PROJECT, { [ROOT_A]: listing })
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    await act(async () => {
      rowByText(tab, 'proj (主)').click()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      rowByText(tab, 'readme.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const text = tab.ownerDocument.body.textContent ?? ''
    expect(text).toContain('引用到对话')
    expect(text).toContain('下载')
    expect(text).not.toContain('上传到此处')
  })

  it('surfaces a project-fetch error instead of crashing', async () => {
    const fake = fakeApi(null)
    fake.api.project = async () => { throw new Error('boom') }
    const { tab } = await renderTab(fake.api, fakeCtx().ctx)
    expect(tab.textContent).toContain('boom')
  })
})
