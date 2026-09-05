/**
 * 文件预览 tab — the plugin's per-file preview opened as its own sidebar tab.
 *
 * When better-sidebar is installed, clicking a file in the 项目文件夹 tree
 * opens it here (via `openTab({ type: 'codex-project:file', path })`) instead
 * of an inline pane inside the tree tab. It reuses the plugin's own
 * `PreviewPane`, which reads through the plugin's multi-root `/codex-project`
 * routes — so files in CROSS-DRIVE shared directories (outside the session's
 * `cwd` workspace) preview fine, which better-sidebar's own editor (fenced to
 * the session cwd) cannot.
 *
 * The tab is registered with `hidden: true` and deduped by path id, so it only
 * ever opens programmatically and each open file gets (or focuses) its own tab.
 * @module dsh-codex-project/client/preview-tab
 */

import type { ReactNode } from 'react'

import type { SpacesApi } from './api.ts'
import type { SidebarTabComponentProps } from './context.ts'
import { PreviewPane } from './preview-pane.tsx'

/** A registered file-preview tab: renders the preview of `tab.path`. */
export interface PreviewTabProps {
  api: SpacesApi
  /** The better-sidebar tab render props (scope carries the session cwd). */
  tabProps: SidebarTabComponentProps
}

/**
 * The file-preview tab body.
 * @param props - the dirs API and the better-sidebar tab props.
 */
export function FilePreviewTab(props: PreviewTabProps): ReactNode {
  const { api, tabProps } = props
  const path = tabProps.tab?.path
  const cwd = tabProps.scope.cwd
  if (path === undefined || path === '') {
    return <div className="dsh-cxp-tab-note">未指定要预览的文件</div>
  }
  if (cwd === undefined || cwd === '') {
    return <div className="dsh-cxp-tab-note">等待工作区…</div>
  }
  return (
    <div className="dsh-cxp-tab" data-dsh-codex-project-tab>
      <PreviewPane key={path} api={api} cwd={cwd} path={path} />
    </div>
  )
}
