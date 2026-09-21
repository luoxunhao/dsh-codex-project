/**
 * SQLite persistence tests for the dirs store. Writes are single-transaction
 * replacements over a real temporary database: the full record map is committed
 * (never half-written), a later load reads the committed rows back, and the DB
 * path is honored through `DSH_CODEX_PROJECT_CONFIG`. This guards the storage
 * contract the plugin's config now relies on (no temp-file + rename, so the
 * Windows EPERM that a JSON config could hit is structurally gone) — including
 * the on-open `ALTER TABLE` that adds `primary_dir` to a pre-existing database.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, it } from 'vitest'

import { closeDirsDb, loadWorkspaceDirs, writeWorkspaceDirs } from '../src/dirs-config.ts'
import { DirsStore } from '../src/dirs-store.ts'

describe('DirsStore.addDir (the one "add a dir to a workspace" primitive)', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-adddir-store-'))
  const workspacePath = join(base, 'ws')
  const dirA = join(base, 'dir-a')
  const dirB = join(base, 'dir-b')
  const configPath = join(base, 'dirs.db')
  const previousConfig = process.env.DSH_CODEX_PROJECT_CONFIG
  const store = new DirsStore()

  afterAll(() => {
    if (previousConfig === undefined) delete process.env.DSH_CODEX_PROJECT_CONFIG
    else process.env.DSH_CODEX_PROJECT_CONFIG = previousConfig
    closeDirsDb()
    rmSync(base, { recursive: true, force: true })
  })

  it('auto-anchors a workspace with no record yet (first addition creates it)', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    closeDirsDb()
    expect(loadWorkspaceDirs()['w1']).toBeUndefined()

    await store.addDir('w1', workspacePath, dirA)
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [dirA] } })
  })

  it('appends to an existing record without touching its path or earlier dirs', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    await store.addDir('w1', workspacePath, dirB)
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [dirA, dirB] } })
  })

  it('adding a duplicate is a no-op (idempotent)', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    await store.addDir('w1', workspacePath, dirA)
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [dirA, dirB] } })
  })
})


describe('SQLite dirs persistence', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-write-'))
  const rootA = join(base, 'root-a')
  const rootB = join(base, 'root-b')
  const configPath = join(base, 'dirs.db')
  const previousConfig = process.env.DSH_CODEX_PROJECT_CONFIG

  afterAll(() => {
    if (previousConfig === undefined) delete process.env.DSH_CODEX_PROJECT_CONFIG
    else process.env.DSH_CODEX_PROJECT_CONFIG = previousConfig
    closeDirsDb()
    rmSync(base, { recursive: true, force: true })
  })

  it('creates the database and persists the full record map', () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    closeDirsDb()
    expect(existsSync(configPath)).toBe(false)
    writeWorkspaceDirs({ w1: { path: rootA, dirs: [rootB] } })
    expect(existsSync(configPath)).toBe(true)
    expect(loadWorkspaceDirs()['w1']).toEqual({ path: rootA, dirs: [rootB] })
  })

  it('replaces the whole set on the next write (a single transaction)', () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    writeWorkspaceDirs({ w2: { path: rootB, dirs: [] } })
    // The previous record is gone — the map is fully replaced, not merged.
    expect(loadWorkspaceDirs()).toEqual({ w2: { path: rootB, dirs: [] } })
  })

  it('round-trips an empty set and an empty dirs list', () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    writeWorkspaceDirs({ w2: { path: rootB, dirs: [] } })
    expect(loadWorkspaceDirs()['w2']?.dirs).toEqual([])
    writeWorkspaceDirs({})
    expect(loadWorkspaceDirs()).toEqual({})
  })

  it('upgrades a database written before the primary column existed', () => {
    const legacy = join(base, 'legacy.db')
    process.env.DSH_CODEX_PROJECT_CONFIG = legacy
    closeDirsDb()
    // Hand-write the pre-`primary_dir` schema and one row, like an installed 0.13 DB.
    const db = new DatabaseSync(legacy)
    db.exec('CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, path TEXT NOT NULL, dirs_json TEXT NOT NULL) STRICT')
    db.prepare('INSERT INTO workspaces (workspace_id, path, dirs_json) VALUES (?, ?, ?)').run('w1', rootA, JSON.stringify([rootB]))
    db.close()

    // Opening the handle ALTERs the table in place: the old row still reads back…
    expect(loadWorkspaceDirs()).toEqual({ w1: { path: rootA, dirs: [rootB] } })
    // …and the new column is writable.
    writeWorkspaceDirs({ w1: { path: rootA, dirs: [rootB], primary: rootB } })
    expect(loadWorkspaceDirs()).toEqual({ w1: { path: rootA, dirs: [rootB], primary: rootB } })
    closeDirsDb()
    rmSync(legacy, { force: true })
  })

  it('honors a different DB path when the env var moves', () => {
    const second = join(base, 'second.db')
    process.env.DSH_CODEX_PROJECT_CONFIG = second
    closeDirsDb()
    writeWorkspaceDirs({ a: { path: rootA, dirs: [] } })
    expect(loadWorkspaceDirs()).toEqual({ a: { path: rootA, dirs: [] } })
    // The original DB is untouched by writes to the second path.
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    closeDirsDb()
    expect(loadWorkspaceDirs()).toEqual({})
    process.env.DSH_CODEX_PROJECT_CONFIG = second
    closeDirsDb()
    rmSync(second, { force: true })
  })
})
