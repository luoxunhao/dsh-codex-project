/**
 * Test helpers for the SQLite-backed dirs store. Specs that used to seed a
 * `dirs.json` now seed the store through its real write primitive
 * (`writeWorkspaceDirs`), and must close the DB handle before removing the
 * temp file (an open handle would make `rmSync` fail on Windows). Centralized
 * here so every spec applies the same lifecycle.
 */

import { rmSync } from 'node:fs'

import { closeDirsDb, writeWorkspaceDirs } from '../../src/dirs-config.ts'
import type { WorkspaceDirs } from '../../src/dirs-config.ts'

/** Point the store at `configPath` and insert `workspaces` (DB created on first write). */
export function seedDirs(configPath: string, workspaces: Record<string, { path: string; dirs: string[] }>): void {
  closeDirsDb()
  process.env.DSH_CODEX_PROJECT_CONFIG = configPath
  writeWorkspaceDirs(workspaces as Record<string, WorkspaceDirs>)
}

/** Close the open handle and drop the DB file (call before any temp cleanup). */
export function clearDirs(configPath: string): void {
  closeDirsDb()
  rmSync(configPath, { force: true })
}
