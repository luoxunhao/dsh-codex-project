/**
 * 页内目录选择（folder picker）host feed — an UNFENCED directory browser for
 * the manage dialog's 添加附加目录 picker. Unlike the fenced project `/list`
 * route, this feed must navigate the whole filesystem so the user can grant
 * write access to any folder (mirroring the OS FolderBrowserDialog's reach).
 *
 * Security boundary: the whole `/codex-project/api` prefix is loopback-guarded
 * in `src/index.ts`, and this feed is READ-ONLY — it only returns directory
 * names and ancestry for navigation, never file contents. It exists solely to
 * let the user point the add-dir action at an arbitrary local folder, the same
 * trust the native picker already grants.
 *
 * Path input on Windows accepts BOTH native forms (`C:\`, `C:/Users/...`) and
 * Git-Bash / MSYS Linux-style roots (`/c`, `/d`, `/c/Users/...`) via
 * {@link normalizePickPath}, so a Win10 user can type `/c` or `/d` to jump to a
 * drive root.
 *
 * Two operations:
 *  - roots: the navigable top level — drive letters on Windows, `/` elsewhere
 *    (plus the OS home for a convenient anchor).
 *  - list: one directory's subdirectories plus its parent path, accepting any
 *    of the normalized input forms.
 * @module dsh-codex-project/pick-browse
 */

import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, sep } from 'node:path'

import { listProjectDirectory } from './project-list.ts'

/** One browsable directory entry (subdirectory or root). */
export interface PickEntry {
  name: string
  path: string
}

/** The navigable root set: every present drive letter + the OS home. */
export function pickRoots(): PickEntry[] {
  const roots: PickEntry[] = []
  if (process.platform === 'win32') {
    // Enumerate present drive letters via their root ("C:\", "D:\", ...).
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`
      if (directoryExists(root)) roots.push({ name: root, path: root })
    }
  } else {
    roots.push({ name: sep, path: sep })
  }
  const home = homedir()
  if (!roots.some(entry => entry.path === home)) {
    roots.push({ name: `~ (${home})`, path: home })
  }
  return roots
}

/**
 * Normalize a user-typed path to an absolute Windows path (on win32) or pass
 * through an absolute posix path elsewhere.
 *
 * Accepted forms on Windows (case-insensitive drive letter):
 *  - Git-Bash / MSYS Linux-style: `/c`, `/c/Users/foo`, `/d` → `C:\`, `C:\Users\foo`, `D:\`
 *  - native drive forms: `C:\`, `C:/Users/foo`, `c:/foo`, `c:`
 *
 * Returns the normalized absolute path, or `undefined` when the input is not a
 * recognizable absolute path for this platform.
 * @param input - the raw path the user typed.
 * @param platform - the target platform (defaults to the host's), injectable
 *   so the win32 Git-Bash mapping is testable on any platform.
 * @returns the normalized absolute path, or undefined.
 */
export function normalizePickPath(input: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const raw = input.trim()
  if (raw === '') return undefined
  if (platform === 'win32') {
    const backslash = raw.replace(/\//g, '\\')
    // Git-Bash "/c", "/c\rest" → "\c", "\c\rest" after the slash swap.
    const gitBash = /^\\([a-zA-Z])(?:\\(.*))?$/.exec(backslash)
    if (gitBash !== null) {
      const drive = `${gitBash[1]!.toUpperCase()}:\\`
      const rest = gitBash[2]
      return rest === undefined || rest === '' ? drive : `${drive}${rest}`
    }
    // Native "C:" with optional "\\" or "C:\rest" / "c:/rest".
    const native = /^([a-zA-Z]):(\\?)(.*)$/.exec(backslash)
    if (native !== null) {
      const drive = `${native[1]!.toUpperCase()}:`
      const hasSep = native[2] !== ''
      const rest = native[3]
      if (rest === '') return `${drive}\\`
      return `${drive}\\${rest}`
    }
    return undefined
  }
  // POSIX: only an absolute path makes sense.
  return raw.startsWith('/') ? raw : undefined
}

/** One directory level: the current dir, its parent, and its subdirectories. */
export interface PickLevel {
  path: string
  /** The absolute parent directory, or null when `path` is a top level. */
  parent: string | null
  /** Direct subdirectories (dirs-first, case-insensitive order). */
  dirs: PickEntry[]
  /** The OS home (an anchor the client can jump to). */
  home: string
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * List one directory level for the picker, accepting any of the input forms
 * {@link normalizePickPath} understands (`/c`, `/c/Users/foo`, `C:\`, ...).
 * @param path - a directory path to browse (native or Git-Bash style).
 * @returns the level's subdirectories, parent, and home anchor.
 * @throws when the path is not an absolute existing directory.
 */
export async function pickLevel(path: string): Promise<PickLevel> {
  const normalized = normalizePickPath(path)
  if (normalized === undefined || !isAbsolute(normalized)) {
    throw new Error('path must be an absolute directory')
  }
  if (!directoryExists(normalized)) {
    throw new Error(`not an existing directory: ${normalized}`)
  }
  const listing = await listProjectDirectory(normalized, 2000)
  const home = homedir()
  return {
    path: listing.path,
    parent: topLevelParent(normalized, home),
    home,
    dirs: listing.entries.filter(entry => entry.isDir).map(entry => ({ name: entry.name, path: entry.path })),
  }
}

/**
 * The directory to navigate to when the user goes "up", or null at a top level
 * (a Windows drive root or `/`). From a drive root, "up" jumps to the home so
 * the user can escape a drive without a dead end.
 * @param path - the current absolute directory.
 * @param home - the OS home.
 * @returns the parent directory, or null at the filesystem root.
 */
function topLevelParent(path: string, home: string): string | null {
  if (isDriveRoot(path)) return home === path ? null : home
  const parent = dirname(path)
  return parent === path ? null : parent
}

/** Whether `path` is a Windows drive root ("C:\") or the posix root ("/"). */
export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(path) || path === '/' || path === '\\'
}
