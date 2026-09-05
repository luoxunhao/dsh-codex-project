/**
 * FolderPicker — the in-page 选择目录 browser inside the 管理工作区 dialog.
 *
 * It replaces the OS-native folder dialog for 添加附加目录: native dialogs
 * spawned by the background dsh web process (windowsHide) never grab the
 * foreground, so they open behind the browser — and passing the browser window
 * as an owner breaks the dialog entirely. An in-page browser is always on top
 * of the GUI and has focus by construction.
 *
 * UX: start at the workspace's own path; show its subdirectories; clicking a
 * directory descends; up/home ascends to the drive roots; a PATH INPUT accepts
 * native (`C:\`, `C:/Users/...`) and Git-Bash Linux-style (`/c`, `/d`,
 * `/c/Users/...`) paths and jumps there (on Win10 typing `/c` / `/d` goes to a
 * drive root). The user selects the CURRENT directory as the additional
 * writable dir.
 *
 * Data comes from the plugin's own unbounded (loopback, read-only) pick-browse
 * host feed, so it needs no DSH directory-picker backend.
 * @module dsh-codex-project/client/folder-picker
 */

import { useEffect, useState, type ReactNode } from 'react'

import { Button, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PickLevel, PickRoot, SpacesApi } from './api.ts'

/** The picker's injected face. */
export interface FolderPickerProps {
  api: SpacesApi
  /** The directory to open at (the workspace's own path). */
  initialPath: string
  /** Confirm the currently-viewed directory as the selection. */
  onPick(path: string): void
  /** Dismiss without a selection. */
  onCancel(): void
}

/**
 * The in-page directory browser body.
 * @param props - the api, the initial path, and the pick/cancel callbacks.
 */
export function FolderPicker(props: FolderPickerProps): ReactNode {
  const { api, initialPath, onPick, onCancel } = props
  // The directory currently viewed (canonical).
  const [path, setPath] = useState(initialPath)
  // The path input's draft text.
  const [draft, setDraft] = useState('')
  const [level, setLevel] = useState<PickLevel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Browse `target` (any accepted form); on success adopt its canonical path
   *  (the host resolves Git-Bash `/c`-style input to a native drive path). */
  const go = async (target: string): Promise<void> => {
    setError(null)
    setBusy(true)
    setDraft('')
    try {
      const next = await api.pickList(target)
      setLevel(next)
      setPath(next.path)
    } catch (reason) {
      setLevel(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  // Initial load only. All subsequent navigation goes through `go`.
  useEffect(() => {
    void go(initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, initialPath])

  const submitDraft = (): void => {
    const typed = draft.trim()
    if (typed !== '' && typed !== path) void go(typed)
  }

  return (
    <div className="dsh-cxp-folder-picker" data-dsh-codex-project-folder-picker>
      <div className="dsh-cxp-folder-picker-path" title={path}>
        <IconFolderOpenOutline16 size={16} />
        <span className="dsh-cxp-folder-picker-crumb">{path}</span>
      </div>
      <div className="dsh-cxp-folder-picker-jump">
        <input
          className="dsh-cxp-folder-picker-input"
          type="text"
          value={draft}
          placeholder="输入路径并回车，如 C:\ 或 Git Bash 风格 /c、/d、/c/Users"
          spellCheck={false}
          onKeyDown={(event) => { if (event.key === 'Enter') submitDraft() }}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" variant="outline" disabled={busy || draft.trim() === ''} onClick={submitDraft}>跳转</Button>
      </div>
      {error !== null && <div className="dsh-cxp-panel-error">{error}</div>}
      {level !== null && (
        <div className="dsh-cxp-folder-picker-actions">
          <Button size="sm" variant="outline" disabled={level.parent === null} onClick={() => { if (level.parent !== null) void go(level.parent) }}>
            ↑ 上级
          </Button>
          <Button size="sm" variant="outline" disabled={level.home === path} onClick={() => { void go(level.home) }}>
            主页
          </Button>
          <span style={{ flex: 1 }} />
          {busy && <span className="dsh-cxp-folder-picker-busy">加载中…</span>}
        </div>
      )}
      {level !== null && (
        <div className="dsh-cxp-folder-picker-list">
          {level.dirs.length === 0 && !busy && <div className="dsh-cxp-dialog-empty">（无子目录）</div>}
          {level.dirs.map((dir: PickRoot) => (
            <button
              type="button"
              key={dir.path}
              className="dsh-cxp-folder-picker-row"
              onClick={() => { void go(dir.path) }}
              title={dir.path}
            >
              <IconFolderOpenOutline16 size={15} />
              <span className="dsh-cxp-folder-picker-name">{dir.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dsh-cxp-folder-picker-footer">
        <span className="dsh-cxp-folder-picker-hint">选择当前所在目录作为附加可写目录</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        <Button size="sm" disabled={level === null || busy} onClick={() => { if (level !== null) onPick(level.path) }}>选择当前目录</Button>
      </div>
    </div>
  )
}
