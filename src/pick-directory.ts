/**
 * 选择本地目录 — the host-side native action behind the workspace dialog's
 * 添加附加目录 button. Runs as a plugin-owned route
 * (`POST /codex-project/api/pick-directory`) that spawns a native folder
 * picker dialog and returns the selected path.
 *
 * On Windows, uses PowerShell's FolderBrowserDialog via a small script.
 * Returns the selected absolute path, or null if the user cancelled.
 * @module dsh-codex-project/pick-directory
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Show a native folder picker dialog and return the selected path.
 * @returns the selected absolute path, or null if cancelled.
 */
export async function pickDirectoryNative(): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('native folder picker is only supported on Windows')
  }
  // PowerShell script: shows a FolderBrowserDialog and outputs the selected path.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择附加可写目录"',
    '$dialog.ShowNewFolderButton = $true',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  Write-Output $dialog.SelectedPath',
    '} else {',
    '  Write-Output ""',
    '}',
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30_000,
    windowsHide: true,
  })
  const path = stdout.trim()
  return path === '' ? null : path
}

/**
 * Handle one pick-directory request: show the native picker and return the path.
 * @returns the wire result.
 */
export async function pickDirectoryRequest(): Promise<{ status: number; body: { path: string | null } | { error: string } }> {
  try {
    const path = await pickDirectoryNative()
    return { status: 200, body: { path } }
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}