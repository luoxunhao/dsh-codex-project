/**
 * dsh-codex-project client tests: the native workspace 「…」 menu injection
 * (打开本地目录 + 编辑工作区 items) and the edit dialog it opens — the
 * 源文件夹 list with an in-page 添加/移除 flow and the 设为主要 ordering.
 */

// @vitest-environment jsdom

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PickLevel, PickRoot, SpacesApi } from '../src/client/api.ts'
import type { ClientWorkspacesService, ClientWorkspaceView } from '../src/client/context.ts'
import { WorkspaceDialog } from '../src/client/workspace-dialog.tsx'
import { mountWorkspaceMenuManageEntry, MENU_MANAGE_SELECTOR, MENU_OPEN_DIRECTORY_SELECTOR, DIALOG_SELECTOR } from '../src/client/workspace-menu.ts'

const ROOT_A = 'E:\\proj-a'
const ROOT_B = 'D:\\proj-b'
const ROOT_C = 'E:\\proj-c'
const HOME = 'C:\\Users\\me'

/** The registered workspaces the fakes share. */
const WORKSPACES: ClientWorkspaceView[] = [
  { workspaceId: 'w1', path: ROOT_A, title: 'proj-a' },
  { workspaceId: 'w2', path: ROOT_B, title: 'proj-b' },
  { workspaceId: 'w3', path: ROOT_C, title: 'proj-c' },
]

/** A workspaces fake with a cached list snapshot. */
function fakeWorkspaces():
  { service: ClientWorkspacesService; picks: { count: number } } {
  const picks = { count: 0 }
  const snapshot = { items: [...WORKSPACES] }
  return {
    service: {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      create: async () => ({ workspaceId: 'w-created' }),
    },
    picks,
  }
}

/** A spaces API fake around per-workspace dirs/primary state plus an in-page picker feed. */
function fakeApi(
  dirsByWorkspace: Record<string, string[]> = {},
  fs: Record<string, string[]> = {},
  primaryByWorkspace: Record<string, string> = {},
):
  {
    api: SpacesApi
    dirsByWorkspace: Record<string, string[]>
    primaryByWorkspace: Record<string, string | undefined>
    calls: Array<{ op: string; workspaceId?: string; dirs?: string[]; primary?: string }>
    openedDirs: string[]
    listed: string[]
  } {
  const dirsByWorkspaceCopy = { ...dirsByWorkspace }
  const primaryCopy = { ...primaryByWorkspace }
  const calls: Array<{ op: string; workspaceId?: string; dirs?: string[]; primary?: string }> = []
  const openedDirs: string[] = []
  const listed: string[] = []
  // pickList mirrors the host: subdir names under `path` become absolute children.
  // A minimal Git-Bash-root emulation maps "/d" → "D:\" so the path-input jump is
  // testable without the host's real normalizePickPath (covered in pick-browse.spec).
  const joinPath = (parent: string, name: string): string =>
    parent.endsWith('\\') ? `${parent}${name}` : `${parent}\\${name}`
  const children = (rawPath: string): PickRoot[] => {
    const path = /^\/[a-zA-Z]$/.test(rawPath) ? `${rawPath[1]!.toUpperCase()}:\\` : rawPath
    return (fs[path] ?? []).map(name => ({ name, path: joinPath(path, name) }))
  }
  return {
    dirsByWorkspace: dirsByWorkspaceCopy,
    primaryByWorkspace: primaryCopy,
    calls,
    openedDirs,
    listed,
    api: {
      list: async () => Object.fromEntries(
        Object.entries(dirsByWorkspaceCopy).map(([id, dirs]) => [id, {
          path: id === 'w1' ? ROOT_A : ROOT_B,
          dirs,
          primary: primaryCopy[id],
        }]),
      ),
      getDirs: async (workspaceId) => ({
        dirs: [...(dirsByWorkspaceCopy[workspaceId] ?? [])],
        primary: primaryCopy[workspaceId],
      }),
      setDirs: async (workspaceId, dirs, primary) => {
        calls.push({ op: 'setDirs', workspaceId, dirs, primary })
        dirsByWorkspaceCopy[workspaceId] = [...dirs]
        if (primary === undefined) delete primaryCopy[workspaceId]
        else primaryCopy[workspaceId] = primary
        return { dirs: [...dirs], primary: primaryCopy[workspaceId] }
      },
      openDirectory: async (path) => { openedDirs.push(path) },
      pickRoots: async (): Promise<PickRoot[]> => [
        { name: 'E:\\', path: 'E:\\' },
        { name: 'D:\\', path: 'D:\\' },
        { name: `~ (${HOME})`, path: HOME },
      ],
      pickList: async (rawPath): Promise<PickLevel> => {
        listed.push(rawPath)
        const path = /^\/[a-zA-Z]$/.test(rawPath) ? `${rawPath[1]!.toUpperCase()}:\\` : rawPath
        const parent = /^[A-Za-z]:\\$/.test(path) ? null : HOME
        return { path, parent, home: HOME, dirs: children(path) }
      },
      project: async () => null,
      listDir: async () => ({ path: '', entries: [], truncated: false }),
      readFile: async () => ({ content: '', truncated: false }),
      writeFile: async () => {},
      searchProject: async () => [],
      upload: async () => 0,
      fileUrl: (_cwd, path) => `/file?path=${encodeURIComponent(path)}`,
      downloadUrl: (_cwd, path) => `/file?path=${encodeURIComponent(path)}&download=1`,
    },
  }
}

/** Click one button by its text content. */
function clickButton(container: HTMLElement, text: string): void {
  const button = Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.includes(text))
  expect(button, `button containing "${text}"`).toBeDefined()
  button!.click()
}

describe('workspace … menu injection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** A fake open workspace row + its portalled menu popup (rects: popup just
   *  below the row, so the nearest-popup matcher finds it). The row carries
   *  its menu trigger as the first button, like the native row. */
  function fakeOpenMenu(): { row: HTMLElement; menu: HTMLElement; trigger: HTMLButtonElement } {
    const row = document.createElement('div')
    row.className = '_projectRow_hash _menuOpen_hash'
    const title = document.createElement('span')
    title.className = '_title_hash'
    title.textContent = 'proj-a'
    row.appendChild(title)
    const trigger = document.createElement('button')
    row.appendChild(trigger)
    document.body.appendChild(row)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const viewport = document.createElement('div')
    viewport.setAttribute('role', 'presentation')
    menu.appendChild(viewport)
    document.body.appendChild(menu)
    const rowRect = { top: 100, bottom: 130, left: 50, right: 250, width: 200, height: 30, x: 50, y: 100 }
    const menuRect = { top: 134, bottom: 200, left: 50, right: 250, width: 200, height: 66, x: 50, y: 134 }
    row.getBoundingClientRect = () => rowRect as DOMRect
    menu.getBoundingClientRect = () => menuRect as DOMRect
    return { row, menu, trigger }
  }

  it('injects 打开本地目录 and 编辑工作区 into the open workspace menu', async () => {
    const { menu } = fakeOpenMenu()
    const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
    await new Promise(resolve => setTimeout(resolve, 0))
    const openRow = menu.querySelector<HTMLElement>(MENU_OPEN_DIRECTORY_SELECTOR)
    const manageRow = menu.querySelector<HTMLElement>(MENU_MANAGE_SELECTOR)
    // Native-cell structure: menuitem buttons with a leading 16px icon + label.
    expect(openRow?.getAttribute('role')).toBe('menuitem')
    expect(openRow?.querySelector('svg')).not.toBeNull()
    expect(openRow?.textContent).toBe('打开本地目录')
    expect(manageRow?.getAttribute('role')).toBe('menuitem')
    expect(manageRow?.querySelector('svg')).not.toBeNull()
    expect(manageRow?.textContent).toBe('编辑工作区')
    dispose()
  })

  it('opens the workspace folder on 打开本地目录 click', async () => {
    fakeOpenMenu()
    const escapeEvents: string[] = []
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escapeEvents.push('escape') })
    const fake = fakeApi()
    const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fake.api })
    await new Promise(resolve => setTimeout(resolve, 0))
    const row = document.querySelector<HTMLElement>(MENU_OPEN_DIRECTORY_SELECTOR)!
    await act(async () => {
      row.click()
    })
    await act(async () => {})
    expect(escapeEvents).toEqual(['escape'])
    // The plugin-owned route receives the workspace's canonical path.
    expect(fake.openedDirs).toEqual([ROOT_A])
    dispose()
  })

  it('closes the native menu and opens the dialog on click', async () => {
    fakeOpenMenu()
    const escapeEvents: string[] = []
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escapeEvents.push('escape') })
    const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
    await new Promise(resolve => setTimeout(resolve, 0))
    const item = document.querySelector<HTMLElement>(MENU_MANAGE_SELECTOR)!
    await act(async () => {
      item.click()
    })
    await act(async () => {})
    expect(escapeEvents).toEqual(['escape'])
    const dialog = document.querySelector<HTMLElement>(DIALOG_SELECTOR)
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('编辑工作区')
    dispose()
  })

  it('does not inject while no workspace menu is open', async () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(menu.querySelector(MENU_MANAGE_SELECTOR)).toBeNull()
    dispose()
  })

  it('intercepts the pointer-leave arm when the pointer moves onto the injected item', async () => {
    // The native closeOnPointerLeave grace arms on the pointerout that leaves
    // the trigger toward the item; the plugin intercepts it (the item lives
    // in a separate React root the native region cannot see). A document
    // bubble listener must therefore never observe that pointerout.
    const { row } = fakeOpenMenu()
    const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
    await new Promise(resolve => setTimeout(resolve, 0))
    const host = document.querySelector<HTMLElement>(MENU_MANAGE_SELECTOR)!.parentElement!
    let reachedDocument = false
    document.addEventListener('pointerout', () => { reachedDocument = true })
    row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: host }))
    expect(reachedDocument).toBe(false)
    dispose()
  })

  it('mirrors the native grace close when the pointer leaves the item to the outside', async () => {
    vi.useFakeTimers()
    try {
      fakeOpenMenu()
      const escapeEvents: string[] = []
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escapeEvents.push('escape') })
      const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
      await vi.advanceTimersByTimeAsync(0)
      const host = document.querySelector<HTMLElement>(MENU_MANAGE_SELECTOR)!.parentElement!
      // Leaving the menu region (relatedTarget = the page, not the popup or trigger).
      host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
      await vi.advanceTimersByTimeAsync(210)
      expect(escapeEvents).toEqual(['escape'])
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the menu open when the pointer moves from the item back to the trigger', async () => {
    vi.useFakeTimers()
    try {
      const { trigger } = fakeOpenMenu()
      const escapeEvents: string[] = []
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escapeEvents.push('escape') })
      const dispose = mountWorkspaceMenuManageEntry({ workspaces: fakeWorkspaces().service, api: fakeApi().api })
      await vi.advanceTimersByTimeAsync(0)
      const host = document.querySelector<HTMLElement>(MENU_MANAGE_SELECTOR)!.parentElement!
      host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: trigger }))
      await vi.advanceTimersByTimeAsync(210)
      expect(escapeEvents).toEqual([])
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorkspaceDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const workspace = (): ClientWorkspaceView => WORKSPACES[0]!

  /** Mount the dialog against one fake and flush its dirs load. */
  async function mount(
    fake: ReturnType<typeof fakeApi>,
    onClose: () => void = () => {},
  ): Promise<{ container: HTMLElement; unmount(): void }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WorkspaceDialog, {
        workspace: workspace(),
        api: fake.api,
        onClose,
      }))
    })
    await act(async () => {})
    return { container, unmount: () => { root.unmount(); container.remove() } }
  }

  /** The 源文件夹 rows' folder names, in the order the dialog lists them. */
  function rowLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.dsh-cxp-dialog-row .dsh-cxp-root-label'))
      .map(node => node.textContent ?? '')
  }

  /** One row's action button, addressed by its folder name and a button selector. */
  function rowAction(container: HTMLElement, label: string, selector: string): HTMLButtonElement {
    const row = Array.from(container.querySelectorAll<HTMLElement>('.dsh-cxp-dialog-row'))
      .find(candidate => candidate.querySelector('.dsh-cxp-root-label')?.textContent === label)
    const button = row?.querySelector<HTMLButtonElement>(selector)
    expect(button, `row "${label}" has no ${selector}`).toBeDefined()
    return button!
  }

  it('lists every source folder and removes an additional one', async () => {
    const fake = fakeApi({ w1: [ROOT_B, ROOT_C] })
    const { container, unmount } = await mount(fake)
    expect(container.textContent).toContain('编辑工作区')
    expect(container.textContent).toContain('源文件夹')
    expect(rowLabels(container)).toEqual(['proj-a', 'proj-b', 'proj-c'])
    // With no 主要 choice the anchor leads and carries the badge; only the
    // additional rows can be removed.
    expect(container.querySelectorAll('.dsh-cxp-root-badge')).toHaveLength(1)
    expect(container.querySelectorAll('button[title="移除该源文件夹"]')).toHaveLength(2)

    await act(async () => { rowAction(container, 'proj-b', 'button[title="移除该源文件夹"]').click() })
    await act(async () => {})
    expect(fake.dirsByWorkspace.w1).toEqual([ROOT_C])
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: [ROOT_C] }])
    expect(rowLabels(container)).toEqual(['proj-a', 'proj-c'])
    unmount()
  })

  it('leads the list with the folder set as 主要', async () => {
    const fake = fakeApi({ w1: [ROOT_B, ROOT_C] })
    const { container, unmount } = await mount(fake)
    await act(async () => { rowAction(container, 'proj-b', '.dsh-cxp-text-btn').click() })
    await act(async () => {})
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: [ROOT_B, ROOT_C], primary: ROOT_B }])
    expect(rowLabels(container)).toEqual(['proj-b', 'proj-a', 'proj-c'])
    // The anchor row is now the one offering 设为主要, and it stays unremovable.
    expect(rowAction(container, 'proj-a', '.dsh-cxp-text-btn')).toBeDefined()
    const anchorRow = Array.from(container.querySelectorAll<HTMLElement>('.dsh-cxp-dialog-row'))
      .find(candidate => candidate.textContent?.includes('proj-a'))!
    expect(anchorRow.querySelector('button[title="移除该源文件夹"]')).toBeNull()
    expect(anchorRow.querySelector('.dsh-cxp-root-badge')).toBeNull()
    unmount()
  })

  it('hands 主要 back to the workspace folder from the anchor row', async () => {
    const fake = fakeApi({ w1: [ROOT_B, ROOT_C] }, {}, { w1: ROOT_C })
    const { container, unmount } = await mount(fake)
    expect(rowLabels(container)).toEqual(['proj-c', 'proj-a', 'proj-b'])
    await act(async () => { rowAction(container, 'proj-a', '.dsh-cxp-text-btn').click() })
    await act(async () => {})
    // Clearing the marker is a PUT without `primary` — the anchor leads again.
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: [ROOT_B, ROOT_C] }])
    expect(fake.primaryByWorkspace.w1).toBeUndefined()
    expect(rowLabels(container)).toEqual(['proj-a', 'proj-b', 'proj-c'])
    unmount()
  })

  it('adds the current (workspace) dir through the in-page picker', async () => {
    const fake = fakeApi({ w1: [] }, { [ROOT_A]: ['shared'] })
    const { container, unmount } = await mount(fake)
    expect(container.textContent).toContain('还没有附加可写目录')
    clickButton(container, '添加')
    await act(async () => {})
    // The in-page picker opened (no OS dialog), listing ROOT_A's subdirs.
    expect(container.textContent).toContain('选择当前目录')
    expect(container.textContent).toContain('shared')
    expect(fake.listed).toContain(ROOT_A)
    clickButton(container, '选择当前目录')
    await act(async () => {})
    expect(fake.dirsByWorkspace.w1).toEqual([ROOT_A])
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: [ROOT_A] }])
    unmount()
  })

  it('descends into a subdirectory and adds that folder', async () => {
    const fake = fakeApi({ w1: [] }, { [ROOT_A]: ['shared'], [`${ROOT_A}\\shared`]: [] })
    const { container, unmount } = await mount(fake)
    clickButton(container, '添加')
    await act(async () => {})
    const target = `${ROOT_A}\\shared`
    clickButton(container, 'shared')
    await act(async () => {})
    expect(container.textContent).toContain(target)
    clickButton(container, '选择当前目录')
    await act(async () => {})
    expect(fake.dirsByWorkspace.w1).toEqual([target])
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: [target] }])
    unmount()
  })

  it('jumps to a Git-Bash style drive root typed in the path input', async () => {
    const fake = fakeApi({ w1: [] }, { 'D:\\': ['data'] })
    const { container, unmount } = await mount(fake)
    clickButton(container, '添加')
    await act(async () => {})
    // Type a Git-Bash root and press Enter → the picker asks pickList('/d').
    const input = container.querySelector<HTMLInputElement>('.dsh-cxp-folder-picker-input')!
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '/d')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {})
    expect(fake.listed).toContain('/d')
    // The host-normalized drive root (D:\) is now displayed and browsable.
    expect(container.textContent).toContain('D:\\')
    clickButton(container, 'data')
    await act(async () => {})
    expect(container.textContent).toContain('D:\\data')
    clickButton(container, '选择当前目录')
    await act(async () => {})
    expect(fake.dirsByWorkspace.w1).toEqual(['D:\\data'])
    expect(fake.calls).toEqual([{ op: 'setDirs', workspaceId: 'w1', dirs: ['D:\\data'] }])
    unmount()
  })

  it('does not add when the picker is cancelled', async () => {
    const fake = fakeApi({ w1: [] }, { [ROOT_A]: ['shared'] })
    const { container, unmount } = await mount(fake)
    clickButton(container, '添加')
    await act(async () => {})
    clickButton(container, '取消')
    await act(async () => {})
    expect(fake.calls).toHaveLength(0)
    expect(fake.dirsByWorkspace.w1).toEqual([])
    unmount()
  })

  it('ignores adding a directory already in the list', async () => {
    const fake = fakeApi({ w1: [ROOT_A] }, { [ROOT_A]: [] })
    const { container, unmount } = await mount(fake)
    clickButton(container, '添加')
    await act(async () => {})
    clickButton(container, '选择当前目录')
    await act(async () => {})
    expect(fake.calls).toHaveLength(0)
    expect(fake.dirsByWorkspace.w1).toEqual([ROOT_A])
    unmount()
  })

  it('closes on Escape', async () => {
    const closed: string[] = []
    const { unmount } = await mount(fakeApi({}), () => { closed.push('closed') })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(closed).toEqual(['closed'])
    unmount()
  })
})
