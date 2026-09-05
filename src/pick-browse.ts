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
 * Two operations:
 *  - roots: the navigable top level — drive letters on Windows, `/` elsewhere
 *    (plus the OS home for a convenient anchor).
 *  - list: one absolute directory's subdirectories plus its parent path.
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
 * List one absolute directory level for the picker.
 * @param path - an absolute directory path to browse.
 * @returns the level's subdirectories, parent, and home anchor.
 * @throws when the path is not an absolute existing directory.
 */
export async function pickLevel(path: string): Promise<PickLevel> {
  if (!isAbsolute(path)) throw new Error('path must be absolute')
  if (!directoryExists(path)) throw new Error(`not an existing directory: ${path}`)
  const listing = await listProjectDirectory(path, 2000)
  const home = homedir()
  return {
    path: listing.path,
    parent: topLevelParent(path, home),
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
