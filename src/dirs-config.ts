/**
 * dsh-codex-project configuration access: the additional-writable-dir model.
 * One workspace owns a record `{ path, dirs }` — `path` is the canonical main
 * workspace directory (the matching anchor the runner also uses), `dirs` are
 * the additional writable directories the workspace's sessions may read/write.
 * The record set is the plugin's ONLY persisted state; sessions whose cwd is
 * outside every record, or whose owning record has no dirs, keep the core
 * single-workspace behavior.
 *
 * Records live in a SQLite database at `$DSH_CODEX_PROJECT_CONFIG` when set,
 * else `~/.dsh-codex-project/dirs.db`. SQLite commits a config update in one
 * transactional write — it never depends on the temp-file + rename swap that
 * Windows can fail with EPERM when the target is briefly locked. A single
 * `workspaces` table holds one row per record; `dirs` is stored as JSON text
 * in `dirs_json`.
 *
 * The driver is Node's built-in `node:sqlite` (`DatabaseSync`): no native
 * module to install or rebuild, so it loads identically in the host, the fs
 * provider, and the confinement runner regardless of the DSH runtime's Node /
 * Electron ABI. This module owns the connection (dirs-store.ts writes through
 * the same one) and the pure matching helpers. The pure helpers
 * (`matchingWorkspace`, `requireCanonicalDirectory`) carry no storage so the
 * fs/runner bundles that import them stay decoupled from the handle mechanics.
 * An absent database means "no records" — the plugin stays a pure pass-through.
 *
 * Matching: a session cwd (canonical) that equals a record's `path` owns that
 * record; the writable root set is `[path, ...surviving dirs]`. A configured
 * dir that vanished narrows the set (a dead directory is physically
 * unwritable), never throwing and never poisoning unrelated sessions or
 * records.
 * @module dsh-codex-project/dirs-config
 */

import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One workspace's persisted record: main path + additional writable dirs. */
export interface WorkspaceDirs {
  /** Canonical main workspace directory (the runner's matching anchor). */
  path: string
  /** Additional writable directories (absolute, may cross drives). */
  dirs: string[]
}

/** A resolved match: the owning workspace + its writable root split. */
export interface WorkspaceMatch {
  workspaceId: string
  /** Canonical surviving writable roots: path + existing dirs. */
  roots: string[]
  /** Configured dirs that no longer exist (skipped, never failing). */
  missingDirs: string[]
}

/** The default data file location (`~/.dsh-codex-project/dirs.db`). */
export const DEFAULT_DIRS_CONFIG_PATH = join(homedir(), '.dsh-codex-project', 'dirs.db')

/** The data file path: `$DSH_CODEX_PROJECT_CONFIG`, else the default. */
export function dirsConfigPath(): string {
  return process.env.DSH_CODEX_PROJECT_CONFIG ?? DEFAULT_DIRS_CONFIG_PATH
}

/** The SQLite table backing the record set: one row per workspace. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    dirs_json    TEXT NOT NULL
  ) STRICT;
`

// A lazily-opened handle keyed by the resolved path. Tests swap
// `DSH_CODEX_PROJECT_CONFIG` between cases (and delete each temp dir), so the
// handle is closed and reopened whenever the resolved path changes.
let connectionPath: string | undefined
let connection: DatabaseSync | undefined

/** The open handle for the current DB path (creating parent/schema on first use). */
function getConnection(): DatabaseSync {
  const path = dirsConfigPath()
  if (connection !== undefined && connectionPath === path) return connection
  closeDirsDb()
  mkdirSync(dirname(path), { recursive: true })
  const next = new DatabaseSync(path)
  next.exec('PRAGMA busy_timeout = 5000')
  next.exec(SCHEMA)
  connection = next
  connectionPath = path
  return next
}

/** Close the open handle (idempotent). Tests call this before removing a DB. */
export function closeDirsDb(): void {
  if (connection !== undefined) {
    try {
      connection.close()
    } catch {
      // Already closed or mid-operation; nothing left to do.
    }
    connection = undefined
    connectionPath = undefined
  }
}

/** Whether the resolved DB path currently has an open handle. */
export function isDirsDbOpen(): boolean {
  return connection !== undefined
}

/**
 * Load the configured workspace dirs from the SQLite store. A missing file
 * means none; a row whose `path`/`dirs_json` is not the documented shape is a
 * configuration error and throws.
 * @returns the configured records (possibly empty).
 */
export function loadWorkspaceDirs(): Record<string, WorkspaceDirs> {
  const db = getConnection()
  const rows = db.prepare('SELECT workspace_id, path, dirs_json FROM workspaces').all() as Array<{
    workspace_id: string
    path: string
    dirs_json: string
  }>
  const records: Record<string, WorkspaceDirs> = {}
  for (const row of rows) {
    let dirs: unknown
    try {
      dirs = JSON.parse(row.dirs_json)
    } catch (error) {
      throw new Error(`DSH config row ${row.workspace_id} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof row.path !== 'string' || row.path === '') {
      throw new Error(`workspace ${row.workspace_id} must have a non-empty string "path"`)
    }
    if (!Array.isArray(dirs) || dirs.some(dir => typeof dir !== 'string' || dir === '')) {
      throw new Error(`workspace ${row.workspace_id} dirs must be an array of non-empty strings`)
    }
    records[row.workspace_id] = { path: row.path, dirs }
  }
  return records
}

/**
 * Replace the whole record set in one transaction. This is the ONLY write
 * primitive the store uses; a single transaction means the set is never
 * observed half-updated, and it needs no temp file + rename (the Windows-EPERM
 * trap the JSON loader fell into).
 * @param records - the full record map to persist.
 */
export function writeWorkspaceDirs(records: Record<string, WorkspaceDirs>): void {
  const db = getConnection()
  const entries = Object.entries(records).map(([workspace_id, record]) => ({
    workspace_id,
    path: record.path,
    dirs_json: JSON.stringify(record.dirs),
  }))
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM workspaces').run()
    const insert = db.prepare('INSERT INTO workspaces (workspace_id, path, dirs_json) VALUES (?, ?, ?)')
    for (const entry of entries) insert.run(entry.workspace_id, entry.path, entry.dirs_json)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction was already aborted (constraint error); nothing to undo.
    }
    throw error
  }
}

/** A local existence probe so the match helpers never touch the DB handle. */
function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Canonicalize one directory, failing loud when it does not exist.
 * @param label - what the directory is, for the error.
 * @param path - the directory to canonicalize.
 * @returns the canonical path (Windows: the `\\?\` real path).
 */
export function requireCanonicalDirectory(label: string, path: string): string {
  if (!exists(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is not an existing directory: ${path}`)
  }
  return realpathSync.native(path)
}

/**
 * Canonicalize one directory without failing: a missing or non-directory path
 * yields `undefined`. A dir that vanished after being configured must never
 * throw — it narrows the writable set instead of failing every match.
 * @param path - the directory to canonicalize.
 * @returns the canonical path, or `undefined` when the path is not a directory.
 */
export function tryCanonicalDirectory(path: string): string | undefined {
  try {
    return requireCanonicalDirectory('dir', path)
  } catch {
    return undefined
  }
}

/**
 * The workspace record whose canonical `path` equals the canonical session
 * workspace, if any.
 * @param records - the loaded records.
 * @param canonicalWorkspace - the canonical session cwd.
 * @returns the owner id, or undefined when no record anchors this workspace.
 */
export function matchingWorkspace(
  records: Record<string, WorkspaceDirs>,
  canonicalWorkspace: string,
): WorkspaceMatch | undefined {
  for (const [workspaceId, record] of Object.entries(records)) {
    if (tryCanonicalDirectory(record.path) !== canonicalWorkspace) continue
    const roots: string[] = []
    const missingDirs: string[] = []
    for (const dir of record.dirs) {
      const canonical = tryCanonicalDirectory(dir)
      if (canonical === undefined) missingDirs.push(dir)
      else roots.push(canonical)
    }
    return { workspaceId, roots: [canonicalWorkspace, ...roots], missingDirs }
  }
  return undefined
}

/**
 * The canonical directory holding the data file. Exists by the store's
 * guarantee once any record is configured (the store creates the parent);
 * the runner derives the workspace SID from it — see `space-sid.ts`.
 */
export function dirsConfigDirectory(): string {
  return requireCanonicalDirectory('dirs config directory', dirname(resolve(dirsConfigPath())))
}
