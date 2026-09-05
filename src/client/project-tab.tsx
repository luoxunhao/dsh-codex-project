/**
 * 项目文件夹 tab (registered into better-sidebar): a FILE-TREE-ONLY panel of
 * the project anchored at the current session's cwd — the main workspace root
 * plus every shared additional dir (cross-drive). It mirrors the better-sidebar
 * Files-tab explorer look: a toolbar with a file-name SEARCH box + refresh +
 * upload-files + upload-folder, above a lazy directory tree whose folder rows
 * expand in place and whose file rows open their preview in a SEPARATE sidebar
 * tab (the plugin's `codex-project:file` tab, which reads through the plugin's
 * multi-root routes — so cross-drive shared dirs preview fine). No inline
 * preview/editor pane lives in this tab; clicking a file hands it to
 * `openPreview`. The search box runs a debounced recursive file-name search
 * over the project roots and shows a flat result list (each opens the preview
 * tab); uploads write files/folders into the project's main root via the
 * plugin's fenced /upload route.
 *
 * With no shared config the tab falls back to the session's own working
 * directory as a single root, so the tree always has content. The tree is
 * self-contained (the client bundle's purity gate forbids value-importing
 * better-sidebar's FileTree): each directory loads its level lazily through the
 * plugin's own /list route, fenced to the project roots on the host. Rows
 * mirror better-sidebar's explorer metrics via the shared `--dsw-*` tokens.
 *
 * Row interactions: expand/collapse a directory; open a file in the preview
 * tab; right-click a row for a context menu (open the folder locally, copy the
 * relative / absolute path, or reference the file in chat as a chip); hover a
 * row to reveal the @-reference button.
 * @module dsh-codex-project/client/project-tab
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  IconCodeOutline16,
  IconCopyOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconFolderOpenOutline16,
  IconLinkOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
  Menu,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { ProjectEntry, ProjectListing, ProjectSearchResult, ProjectView, SpacesApi, UploadFile } from './api.ts'
import type { ClientRuntimeContext, SidebarTabScope } from './context.ts'
import { insertFileReference } from './file-reference.ts'
import { basename, relativePath, resolvePath } from './paths.ts'

/** The tab's render props: the client ctx, the dirs API, the session scope, and
 *  how to open a file's preview (into a separate sidebar tab). */
export interface ProjectTabProps {
  ctx: ClientRuntimeContext
  api: SpacesApi
  scope: SidebarTabScope
  /** Open a file's preview in its own sidebar tab. */
  openPreview: (path: string) => void
}

/** One top-level project root. */
type RootRow = { path: string; kind: 'main' | 'shared' | 'missing' }

/** How long the row's "已复制" label stays after a successful copy. */
const COPIED_MS = 1200

/** A context-menu target: the row path, whether it is a file, plus the cursor position. */
type RowMenuState = { path: string; isFile: boolean; x: number; y: number } | null

/**
 * The 项目文件夹 tree-only tab body.
 * @param props - the client ctx, the dirs API, the session scope, and openPreview.
 */
export function ProjectTab(props: ProjectTabProps): ReactNode {
  const { ctx, api, scope, openPreview } = props
  const cwd = scope.cwd
  const [project, setProject] = useState<ProjectView | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** The row whose path was just copied ("已复制" replaces its @ button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** The open context menu: the target row path plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null)

  const refresh = useCallback(async () => {
    if (cwd === undefined || cwd === '') {
      setProject(null)
      return
    }
    try {
      setProject(await api.project(cwd))
      setError(null)
    } catch (reason) {
      setProject(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [api, cwd])

  useEffect(() => { void refresh() }, [refresh, reloadKey])

  // --- Files-style toolbar state: search + upload ---
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ProjectSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<{ text: string; failed: boolean } | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<number | undefined>(undefined)

  // Debounced project file-name search while the query is non-empty.
  const needle = query.trim()
  useEffect(() => {
    if (cwd === undefined || cwd === '') return
    if (needle === '') { setSearchResults(null); setSearching(false); return }
    setSearching(true)
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => {
      void api.searchProject(cwd, needle).then(
        (results) => { setSearchResults(results); setSearching(false) },
        (reason) => {
          setSearchResults([])
          setSearching(false)
          setUploadStatus({ text: reason instanceof Error ? reason.message : String(reason), failed: true })
        },
      )
    }, 250)
    return () => { window.clearTimeout(searchTimer.current) }
  }, [api, cwd, needle])

  /** Encode one File into the base64 upload shape, walking into subfolders for a
   *  directory selection (browser fills `webkitRelativePath`). */
  const readFileUpload = (file: File): Promise<UploadFile> => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.onload = () => {
      const base64 = typeof reader.result === 'string' ? reader.result.split(',')[1] ?? '' : ''
      // webkitRelativePath is posix; plain files upload into the dir root.
      const rel = file.webkitRelativePath && file.webkitRelativePath !== ''
        ? file.webkitRelativePath
        : file.name
      resolve({ path: rel, contentBase64: base64 })
    }
    reader.readAsDataURL(file)
  })

  const startUpload = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0 || cwd === undefined) return
    const dir = project !== null && project !== undefined ? project.path : cwd
    setUploading(true)
    setUploadStatus(null)
    try {
      const uploads = await Promise.all(Array.from(files).map(readFileUpload))
      const count = await api.upload(cwd, dir, uploads)
      setUploadStatus({ text: `已上传 ${count} 个文件`, failed: false })
      setReloadKey(key => key + 1)
      setQuery('')
    } catch (reason) {
      setUploadStatus({ text: reason instanceof Error ? reason.message : String(reason), failed: true })
    } finally {
      setUploading(false)
    }
  }

  const openDir = useCallback((path: string) => {
    void api.openDirectory(path).catch((reason) => {
      console.error('[dsh-codex-project] open directory failed:', reason)
    })
  }, [api])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  const reference = useCallback((path: string, isDirectory = false) => {
    insertFileReference(ctx, scope, path, { isDirectory })
  }, [ctx, scope])

  /** The hover-revealed @-reference button (or the transient "已复制" label). */
  const rowAction = (path: string, isDirectory = false): ReactNode => {
    if (copiedPath === path) return <span className="dsh-cxp-row-copied">已复制</span>
    return (
      <button
        type="button"
        className="dsh-cxp-row-ref"
        aria-label="在对话中引用"
        title="在对话中引用"
        onClick={(event) => {
          event.stopPropagation()
          reference(path, isDirectory)
        }}
      >
        @
      </button>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isFile: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isFile, x: event.clientX, y: event.clientY })
  }

  // The Files-style toolbar (replaces the old "项目文件夹" title header).
  const toolbar = (
    <div className="dsh-cxp-files-toolbar">
      <div className="dsh-cxp-files-search">
        <IconSearchOutline16 size={14} />
        <input
          className="dsh-cxp-files-search-input"
          value={query}
          placeholder="搜索文件名…"
          spellCheck={false}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        {searching && <span className="dsh-cxp-files-search-spin">…</span>}
      </div>
      <button type="button" className="dsh-cxp-tab-icon-btn" title="刷新" disabled={uploading} onClick={() => { setReloadKey(key => key + 1) }}>
        <IconRefreshOutline16 size={15} />
      </button>
      <button type="button" className="dsh-cxp-tab-icon-btn" title="上传文件" disabled={uploading || cwd === undefined} onClick={() => { fileInputRef.current?.click() }}>
        <IconPaperclipOutline16 size={15} />
      </button>
      <button type="button" className="dsh-cxp-tab-icon-btn" title="上传文件夹" disabled={uploading || cwd === undefined} onClick={() => { folderInputRef.current?.click() }}>
        <IconFolderOpen16 size={15} />
      </button>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void startUpload(e.target.files); e.target.value = '' }} />
      <input ref={folderInputRef} type="file" multiple {...{ webkitdirectory: '' } as object} style={{ display: 'none' }} onChange={(e) => { void startUpload(e.target.files); e.target.value = '' }} />
    </div>
  )

  let body: ReactNode
  if (error !== null) {
    body = <div className="dsh-cxp-tab-note dsh-cxp-tab-error">{error}</div>
  } else if (project === undefined) {
    body = <div className="dsh-cxp-tab-note">加载中…</div>
  } else if (needle !== '') {
    // Search mode: a flat results list replaces the tree.
    const results = searchResults
    body = (
      <div className="dsh-cxp-files-search-results">
        {results === null || searching
          ? <div className="dsh-cxp-tab-note">搜索中…</div>
          : results.length === 0
            ? <div className="dsh-cxp-tab-note">无匹配文件</div>
            : results.map(result => (
              <button
                type="button"
                key={result.path}
                className="dsh-cxp-files-search-row"
                title={result.path}
                onClick={() => { openPreview(result.path) }}
              >
                <FileGlyph />
                <span className="dsh-cxp-files-search-name">{result.path}</span>
              </button>
            ))}
      </div>
    )
  } else {
    // With no shared config, fall back to the session's own working directory
    // as a single root — the tree always has something to show.
    const roots: RootRow[] = project === null
      ? (cwd === undefined || cwd === '' ? [] : [{ path: cwd, kind: 'main' as const }])
      : [
        { path: project.path, kind: 'main' },
        ...project.dirs.map(path => ({ path, kind: 'shared' as const })),
        ...project.missingDirs.map(path => ({ path, kind: 'missing' as const })),
      ]
    body = (
      <div className="dsh-cxp-tab-tree">
        {roots.length === 0 ? (
          <div className="dsh-cxp-tab-note">等待工作区…</div>
        ) : roots.map(root => {
          if (root.kind === 'missing') {
            return <MissingRow key={root.path} path={root.path} />
          }
          const name = root.kind === 'main' && project !== null ? `${basename(root.path)} (主)` : basename(root.path)
          return (
            <DirNode
              key={root.path}
              api={api}
              cwd={cwd!}
              path={root.path}
              name={name}
              depth={0}
              defaultOpen={false}
              refreshTick={reloadKey}
              onOpenFile={openPreview}
              onOpenDir={openDir}
              rowAction={rowAction}
              openRowMenu={openRowMenu}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div className="dsh-cxp-tab" data-dsh-codex-project-tab>
      {toolbar}
      {uploadStatus !== null && (
        <div className={uploadStatus.failed ? 'dsh-cxp-files-status dsh-cxp-files-status-fail' : 'dsh-cxp-files-status'} title={uploadStatus.text}>
          {uploadStatus.text}
        </div>
      )}
      {body}
      {/* One shared context menu, positioned at the right-click cursor (portal
          so the tree's overflow clip cannot crop it). */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          { id: 'open-dir', label: '用文件管理器打开', icon: <IconFolderOpenOutline16 size={14} /> },
          { id: 'relative', label: '复制相对路径', icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: '复制绝对路径', icon: <IconCopyOutline16 size={14} /> },
          { id: 'reference', label: '添加到对话（@引用）', icon: <IconCodeOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-dir') { openDir(target.path); return }
          if (id === 'reference') { reference(target.path, !target.isFile); return }
          copyPath(
            id === 'relative' ? relativePath(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
    </div>
  )
}

/** A stale (missing) root row: flagged, never expandable. */
function MissingRow(props: { path: string }): ReactNode {
  const { path } = props
  return (
    <div className="dsh-cxp-tree-row dsh-cxp-tree-missing" data-is-missing>
      <span className="dsh-cxp-tree-icon"><IconWarningOutline16 size={14} /></span>
      <span className="dsh-cxp-tree-name">{basename(path)} (⚠ directory missing)</span>
    </div>
  )
}

/** A directory row: expands on click to load its children lazily. */
function DirNode(props: {
  api: SpacesApi
  cwd: string
  path: string
  name: string
  depth: number
  defaultOpen: boolean
  refreshTick: number
  onOpenFile: (path: string) => void
  onOpenDir: (path: string) => void
  rowAction: (path: string, isDirectory?: boolean) => ReactNode
  openRowMenu: (event: MouseEvent, path: string, isFile: boolean) => void
}): ReactNode {
  const {
    api, cwd, path, name, depth, defaultOpen, refreshTick, onOpenFile, onOpenDir,
    rowAction, openRowMenu,
  } = props
  const [expanded, setExpanded] = useState(defaultOpen)
  const [listing, setListing] = useState<ProjectListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The refreshTick whose data is currently (or last) fetched for this level.
  // Guarded so a loaded level is not refetched on every render or re-expand, but
  // a `refreshTick` bump (the toolbar refresh) reloads every open level so the
  // visible tree reflects on-disk changes.
  const lastFetchedTick = useRef<number | null>(null)

  useEffect(() => {
    if (!expanded) return
    if (lastFetchedTick.current === refreshTick) return
    lastFetchedTick.current = refreshTick
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void api.listDir(cwd, path).then((result) => {
      if (cancelled) return
      setListing(result)
      setLoading(false)
    }).catch((reason) => {
      if (cancelled) return
      setLoadError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [expanded, refreshTick, api, cwd, path])

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className="dsh-cxp-tree-row dsh-cxp-tree-dir"
        data-is-dir
        style={{ paddingLeft: depth * 22 + 6 }}
        onClick={() => { setExpanded(prev => !prev) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(prev => !prev)
          }
        }}
        onContextMenu={(event) => { openRowMenu(event, path, false) }}
      >
        <span className="dsh-cxp-tree-icon">{expanded ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}</span>
        <span className="dsh-cxp-tree-name">{name}</span>
        {rowAction(path, true)}
      </div>
      {expanded && (
        <div>
          {loading && <div className="dsh-cxp-tree-note" style={{ paddingLeft: (depth + 1) * 22 + 6 }}>加载中…</div>}
          {loadError !== null && <div className="dsh-cxp-tree-note dsh-cxp-tab-error" style={{ paddingLeft: (depth + 1) * 22 + 6 }}>{loadError}</div>}
          {listing !== null && listing.entries.map(entry =>
            entry.isDir
              ? (
                <DirNode
                  key={entry.path}
                  api={api}
                  cwd={cwd}
                  path={entry.path}
                  name={entry.name}
                  depth={depth + 1}
                  defaultOpen={false}
                  refreshTick={refreshTick}
                  onOpenFile={onOpenFile}
                  onOpenDir={onOpenDir}
                  rowAction={rowAction}
                  openRowMenu={openRowMenu}
                />
              )
              : (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                  rowAction={rowAction}
                  openRowMenu={openRowMenu}
                />
              ),
          )}
        </div>
      )}
    </div>
  )
}

/** A compact document/file glyph (mirrors better-sidebar's VscFile). The dsh
 *  code icon (`IconCodeOutline16`) is a `#`-shaped hashtag, so file rows used
 *  it directly would each show a `#`; a proper file icon is drawn inline here. */
function FileGlyph(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 1h4.2L12 4.3v9.2a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8.6 1v3.5H12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

/** A file row: opens its preview in a separate tab on click. */
function FileRow(props: {
  entry: ProjectEntry
  depth: number
  onOpenFile: (path: string) => void
  rowAction: (path: string, isDirectory?: boolean) => ReactNode
  openRowMenu: (event: MouseEvent, path: string, isFile: boolean) => void
}): ReactNode {
  const { entry, depth, onOpenFile, rowAction, openRowMenu } = props
  return (
    <div
      role="button"
      tabIndex={0}
      className="dsh-cxp-tree-row dsh-cxp-tree-file"
      data-is-file
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.broken ? `${entry.path}（符号链接已失效）` : entry.path}
      onClick={() => { onOpenFile(entry.path) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenFile(entry.path)
        }
      }}
      onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
    >
      <span className="dsh-cxp-tree-icon"><FileGlyph /></span>
      <span className="dsh-cxp-tree-name">{entry.name}</span>
      {entry.isSymlink && <IconLinkOutline16 size={12} className="dsh-cxp-tree-symlink" />}
      {rowAction(entry.path)}
    </div>
  )
}
