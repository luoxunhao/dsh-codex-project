/**
 * dsh-codex-project configuration store: the read-modify-write layer over the
 * SQLite dirs database (`$DSH_CODEX_PROJECT_CONFIG` or
 * `~/.dsh-codex-project/dirs.db`, owned by `src/dirs-config.ts`). Writes
 * replace the whole record set inside one SQLite transaction (no temp file +
 * rename, so the Windows EPERM that plagued a JSON config never applies) and
 * are serialized through a promise queue so interleaved requests cannot lose
 * updates; reads go straight to the shared loader. Every mutation validates
 * that each directory exists (a saved dir must be runnable; a dir vanishing
 * later merely narrows the grant at confinement time).
 * @module dsh-codex-project/dirs-store
 */

import { realpathSync } from 'node:fs'

import { loadWorkspaceDirs, writeWorkspaceDirs } from './dirs-config.ts'
import type { WorkspaceDirs } from './dirs-config.ts'

/** A mutation/query failure: invalid request, unknown workspace, or a fenced path. */
export class DirsStoreError extends Error {
  constructor(
    /** `not-found` (unknown workspace), `invalid` (bad shape/missing dir), or `forbidden` (fence). */
    public readonly code: 'not-found' | 'invalid' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'DirsStoreError'
  }
}

/** The host workspace registry face (structural; see @deepseek-ai/dsh-workspace). */
export interface WorkspaceRegistryFace {
  /** Fresh ordered workspace projection (canonical paths). */
  list(): Array<{ id: string; path: string }>
}

// The npm cordis instance in this plugin's dependency graph does not see the
// dsh monorepo's augmentation, so the service property is restated here —
// the same structural-mirror pattern the rest of the plugin uses.
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistryFace
  }
}

/** Serialize one mutation over the record set, atomically (SQLite transaction). */
export class DirsStore {
  private queue: Promise<unknown> = Promise.resolve()

  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /** The configured records (shared loader; a malformed row fails loud). */
  async load(): Promise<Record<string, WorkspaceDirs>> {
    return loadWorkspaceDirs()
  }

  /**
   * Replace one workspace's additional dirs. The workspace must already have
   * a record (created by migration or by anchoring a registry workspace).
   * Every dir must exist and be a directory; empty arrays clear the extras.
   * @param workspaceId - the owning workspace.
   * @param dirs - the additional writable dirs (may be empty).
   * @returns the updated record.
   */
  async setDirs(workspaceId: string, dirs: string[]): Promise<WorkspaceDirs> {
    return this.enqueue(() => {
      const records = loadWorkspaceDirs()
      const record = records[workspaceId]
      if (record === undefined) throw new DirsStoreError('not-found', `no workspace ${workspaceId}`)
      record.dirs = dedupeDirectionary(dirs)
      writeWorkspaceDirs(records)
      return { ...record }
    })
  }

  /**
   * Add ONE additional writable directory to a workspace, auto-anchoring the
   * workspace when it has no record yet. Shared by the two single-dir entry
   * points (the `/adddir` command and the `add_dir` model tool); the API's
   * full-list PUT reaches the same end state through a separate `anchor` +
   * `setDirs` pair (see dirs-api.ts) rather than calling this. Either way a
   * first-time addition on a fresh workspace never fails with an
   * unanchored-workspace error. An existing record keeps its path.
   * @param workspaceId - the owning workspace.
   * @param path - the canonical main workspace path (used only to anchor when the record is absent).
   * @param dir - the additional writable directory to add (must exist; a duplicate is a no-op).
   * @returns the updated record.
   */
  async addDir(workspaceId: string, path: string, dir: string): Promise<WorkspaceDirs> {
    return this.enqueue(() => {
      const records = loadWorkspaceDirs()
      if (records[workspaceId] === undefined) {
        records[workspaceId] = { path, dirs: [] }
      }
      const record = records[workspaceId]!
      record.dirs = dedupeDirectionary([...record.dirs, dir])
      writeWorkspaceDirs(records)
      return { ...record }
    })
  }

  /**
   * Anchor a registry workspace (id + canonical path) with the given dirs,
   * creating the record when absent. Idempotent: an existing record keeps
   * its dirs unless `dirs` is provided.
   * @param workspaceId - the owning workspace.
   * @param path - the canonical main workspace path.
   * @param dirs - optional initial additional dirs.
   * @returns the record.
   */
  async anchor(workspaceId: string, path: string, dirs: string[] = []): Promise<WorkspaceDirs> {
    return this.enqueue(() => {
      const records = loadWorkspaceDirs()
      const existing = records[workspaceId]
      if (existing !== undefined) {
        if (dirs.length > 0) existing.dirs = dedupeDirectionary(dirs)
        return { ...existing }
      }
      const record: WorkspaceDirs = { path, dirs: dedupeDirectionary(dirs) }
      records[workspaceId] = record
      writeWorkspaceDirs(records)
      return { ...record }
    })
  }

  /** Remove one workspace's record (add-dir is additive; removal is explicit). */
  async remove(workspaceId: string): Promise<void> {
    return this.enqueue(() => {
      const records = loadWorkspaceDirs()
      if (!(workspaceId in records)) throw new DirsStoreError('not-found', `no workspace ${workspaceId}`)
      delete records[workspaceId]
      writeWorkspaceDirs(records)
    })
  }
}

/** Preserve insertion order, drop duplicates by canonical comparison. */
function dedupeDirectionary(dirs: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of dirs) {
    const canonical = trySignificantPath(dir)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    result.push(dir)
  }
  return result
}

/** Canonical-ish identity for dedupe (best effort; fall back to spelling). */
function trySignificantPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Persist the full record map. Retained under its original name because
 * `dirs-migration.ts` imports it; the write is a single SQLite transaction.
 * @param records - the full record map.
 */
export function persistWorkspaceDirs(records: Record<string, WorkspaceDirs>): void {
  writeWorkspaceDirs(records)
}
