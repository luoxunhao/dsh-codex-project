/**
 * Recursive project file-name search for the 项目文件夹 tab's toolbar box: a
 * read-only walk of a project's roots (main root + surviving shared dirs)
 * returning files/dirs whose basename contains the query (case-insensitive).
 * A symlink is only reported / descended into when its resolved target stays
 * under the root it was found in, so the walk never surfaces paths outside the
 * fence. Kept local to the plugin — mirrors better-sidebar's global file search
 * feed without importing that plugin's runtime symbols.
 * @module dsh-codex-project/project-search
 */

import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

import { isPathUnder } from './containment.ts'

/** One search hit: an absolute path plus its matched basename. */
export interface SearchResult {
  path: string
  name: string
}

/** Default cap on total hits (better-sidebar bounds its search similarly). */
export const SEARCH_CAP = 400

/**
 * Recursively collect project entries whose basename contains `query`
 * (lowercased, case-insensitive), bounded by `cap`. Each root's tree is walked
 * with read-only `opendir`; symlink directories whose target escapes the root
 * are not descended into, and matching symlink files are only reported when
 * their target stays under the root. Results are deduped by absolute path in
 * case roots nest/overlap.
 * @param roots - the project's writable roots (main root + surviving dirs).
 * @param query - the needle; an empty/whitespace query returns [].
 * @param cap - the total-result bound (further matches are dropped).
 * @returns the matching entries.
 */
export async function searchProjectFiles(
  roots: readonly string[],
  query: string,
  cap = SEARCH_CAP,
): Promise<SearchResult[]> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const out: SearchResult[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (out.length >= cap) break
    await walk(root, root, needle, out, seen, cap)
  }
  return out
}

/**
 * Walk one directory's tree under `root`, appending matches until `cap`.
 * @param dir - the directory being read.
 * @param root - the root this subtree belongs to (containment fence).
 * @param needle - the lowercased search needle.
 * @param out - the accumulated results.
 * @param seen - absolute paths already reported (dedupe across overlapping roots).
 * @param cap - the total-result bound.
 */
async function walk(
  dir: string,
  root: string,
  needle: string,
  out: SearchResult[],
  seen: Set<string>,
  cap: number,
): Promise<void> {
  let level
  try {
    level = await opendir(dir)
  } catch {
    return // unreadable / vanished subtree: skip quietly
  }
  try {
    for await (const dirent of level) {
      if (out.length >= cap) return
      const entryPath = join(dir, dirent.name)
      const isSymlink = dirent.isSymbolicLink()
      // A symlink's target decides containment; a broken link or one that
      // resolves outside the root is neither reported nor descended into.
      if (isSymlink && !(await isPathUnder(entryPath, root))) continue
      if (dirent.name.toLowerCase().includes(needle)) {
        pushMatch(entryPath, dirent.name, out, seen)
        if (out.length >= cap) return
      }
      if (dirent.isDirectory() && !isSymlink) {
        await walk(entryPath, root, needle, out, seen, cap)
      }
    }
  } finally {
    await level.close().catch(() => {})
  }
}

/** Report one match unless its path was already seen. */
function pushMatch(path: string, name: string, out: SearchResult[], seen: Set<string>): void {
  if (seen.has(path)) return
  seen.add(path)
  out.push({ path, name })
}
