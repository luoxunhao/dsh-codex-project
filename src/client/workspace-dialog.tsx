/**
 * The 编辑工作区 dialog: the plugin's own small popup (rendered into
 * `document.body`, closed by Escape / outside click / the close button) that
 * manages one workspace's source folders — its own directory plus the
 * additional writable directories its sessions may also read and write.
 *
 * Layout mirrors the host's own workspace editor: a 源文件夹 section whose
 * header carries the 「+ 添加」 affordance, one rounded row per folder (folder
 * glyph, name, and the 主要 badge on the leading row), and per-row actions —
 * 设为主要 on any row that is not the primary one, × on the removable
 * (additional) rows.
 *
 * 主要 decides which root leads and is called the primary one: the list here,
 * the 项目文件夹 tab's root rows, and the directory list injected into the
 * model's context reminder. It never moves the anchor — the workspace's own
 * directory is still what matches a session cwd and what the fence is built
 * from, so setting another folder as 主要 never widens or narrows what a
 * session can touch (it only re-folds the reminder text on the next turn).
 *
 * Adding a folder opens an IN-PAGE folder picker (`FolderPicker`) rather than
 * an OS dialog: native dialogs spawned by the background dsh web process never
 * grab the foreground (they open behind the browser), so the selection is
 * rendered in-page, where it is always on top of the GUI and focused.
 * @module dsh-codex-project/client/workspace-dialog
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCloseOutline16, IconFolderOpenOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SpacesApi, WorkspaceDirState } from './api.ts'
import type { ClientWorkspaceView } from './context.ts'
import { FolderPicker } from './folder-picker.tsx'
import { basename, samePath } from './paths.ts'

/** The dialog's injected face. */
export interface WorkspaceDialogProps {
  /** The workspace whose 「…」 menu was clicked. */
  workspace: ClientWorkspaceView
  api: SpacesApi
  /** Close the dialog. */
  onClose(): void
}

/** One row of the 源文件夹 list: the anchor workspace folder or an additional dir. */
interface SourceRow {
  path: string
  /** The anchor is the workspace's own directory — listed, never removable. */
  anchor: boolean
}

/** The hint under the list: what 主要 changes (and what it never touches). */
const PRIMARY_HINT = '「主要」决定这里的列表、「项目文件夹」根行与注入给模型的目录说明谁排第一；列出的每个目录会话都可读写。'

/**
 * The edit-workspace dialog body.
 * @param props - the workspace, the dirs API, and the close callback.
 */
export function WorkspaceDialog(props: WorkspaceDialogProps): ReactNode {
  const { workspace, api, onClose } = props
  const [state, setState] = useState<WorkspaceDirState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // When true the in-page folder picker replaces the list body.
  const [picking, setPicking] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setState(await api.getDirs(workspace.workspaceId))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  useEffect(() => { void refresh() }, [api, workspace.workspaceId])

  // Escape closes the dialog (native listener, like the workspace menus). When
  // the picker is open, Escape first closes the picker back to the list.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (picking) setPicking(false)
      else onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [picking, onClose])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const dirs = state?.dirs ?? []
  const primary = state?.primary

  /** Replace the record (the PUT takes the whole dirs list plus the primary). */
  const save = (nextDirs: string[], nextPrimary?: string): Promise<void> => run(async () => {
    await api.setDirs(workspace.workspaceId, nextDirs, nextPrimary)
  })

  const addPickedDirectory = (picked: string): Promise<void> => {
    setPicking(false)
    // Already granted: nothing to write (the picker's current folder is a
    // common pick when the workspace dir itself is added).
    if (dirs.some(candidate => samePath(candidate, picked))) return Promise.resolve()
    return save([...dirs, picked], primary)
  }

  const removeDirectory = (root: string): Promise<void> => save(
    dirs.filter(candidate => !samePath(candidate, root)),
    primary !== undefined && samePath(primary, root) ? undefined : primary,
  )

  /** Make one folder the leading row; the anchor claims it back by clearing the marker. */
  const setPrimary = (row: SourceRow): Promise<void> => save(dirs, row.anchor ? undefined : row.path)

  /** The list order: the primary row first, then the anchor, then the rest as configured. */
  const rows = (): SourceRow[] => {
    const anchor: SourceRow = { path: workspace.path, anchor: true }
    const extras = dirs.map(path => ({ path, anchor: false } satisfies SourceRow))
    if (primary === undefined) return [anchor, ...extras]
    const leading = extras.find(row => samePath(row.path, primary))
    if (leading === undefined) return [anchor, ...extras]
    return [leading, anchor, ...extras.filter(row => row !== leading)]
  }

  const isPrimary = (row: SourceRow): boolean =>
    primary === undefined ? row.anchor : samePath(primary, row.path)

  return (
    <div
      className="dsh-cxp-dialog-overlay"
      data-dsh-codex-project-dialog
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          if (picking) setPicking(false)
          else onClose()
        }
      }}
    >
      <div className="dsh-cxp-dialog" role="dialog" aria-label={`编辑工作区：${workspace.title}`}>
        <div className="dsh-cxp-dialog-header">
          <span className="dsh-cxp-dialog-title">{picking ? '选择附加可写目录' : '编辑工作区'}</span>
          <span style={{ flex: 1 }} />
          <Button
            variant="ghost"
            onClick={() => { if (picking) setPicking(false); else onClose() }}
            title={picking ? '返回' : '关闭'}
          >
            <IconCloseOutline16 />
          </Button>
        </div>
        <div className="dsh-cxp-dialog-body">
          {picking ? (
            <FolderPicker
              api={api}
              initialPath={workspace.path}
              onPick={(picked) => { void addPickedDirectory(picked) }}
              onCancel={() => setPicking(false)}
            />
          ) : (
            <>
              {error !== null && <div className="dsh-cxp-panel-error">{error}</div>}
              {state === null && <div className="dsh-cxp-dialog-empty">加载中…</div>}

              {state !== null && (
                <div className="dsh-cxp-dialog-section-row">
                  <span className="dsh-cxp-dialog-section">源文件夹</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="dsh-cxp-add-btn" disabled={busy} onClick={() => setPicking(true)}>
                    <IconPlusOutline16 size={14} /> 添加
                  </button>
                </div>
              )}

              {state !== null && rows().map(row => (
                <div key={row.path} className="dsh-cxp-dialog-row" title={row.path}>
                  <span className="dsh-cxp-root-icon"><IconFolderOpenOutline16 size={16} /></span>
                  <span className="dsh-cxp-root-label">{basename(row.path)}</span>
                  {isPrimary(row) && <span className="dsh-cxp-root-badge">主要</span>}
                  <span style={{ flex: 1 }} />
                  {!isPrimary(row) && (
                    <button
                      type="button"
                      className="dsh-cxp-text-btn"
                      disabled={busy}
                      onClick={() => { void setPrimary(row) }}
                    >
                      设为主要
                    </button>
                  )}
                  {!row.anchor && (
                    <button
                      type="button"
                      className="dsh-cxp-icon-btn"
                      title="移除该源文件夹"
                      disabled={busy}
                      onClick={() => { void removeDirectory(row.path) }}
                    >
                      <IconCloseOutline16 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {state !== null && dirs.length === 0 && (
                <div className="dsh-cxp-dialog-empty">还没有附加可写目录，点「添加」授权一个文件夹。</div>
              )}
              {state !== null && <div className="dsh-cxp-dialog-hint">{PRIMARY_HINT}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
