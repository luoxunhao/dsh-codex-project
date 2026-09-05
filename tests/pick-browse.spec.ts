/**
 * In-page folder-picker host tests: the unbounded (loopback, read-only)
 * directory browser feed behind the manage dialog's 添加附加目录 picker. Covers
 * the pure helpers (`pickRoots` / `pickLevel`) and their `dirsApi` route
 * wiring (pick-roots / pick-list).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { normalizePickPath, pickLevel, pickRoots } from '../src/pick-browse.ts'
import { DirsStore } from '../src/dirs-store.ts'
import type { WorkspaceRegistryFace } from '../src/dirs-store.ts'
import { dirsApi } from '../src/dirs-api.ts'

describe('pickRoots / pickLevel', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pick-'))
  const nested = join(base, 'nested')
  mkdirSync(nested)

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('lists only directories of a level, dirs-first, with a parent', async () => {
    mkdirSync(join(base, 'a-dir'))
    writeFileSync(join(base, 'a-file.txt'), 'x')
    const level = await pickLevel(base)
    expect(level.path).toBe(base)
    // Only directories appear, in dirs-first order.
    const names = level.dirs.map(entry => entry.name)
    expect(names).toContain('nested')
    expect(names).toContain('a-dir')
    expect(names.some(name => name === 'a-file.txt')).toBe(false)
    expect(level.parent).not.toBeNull()
    expect(typeof level.home).toBe('string')
  })

  it('rejects a relative or missing path', async () => {
    await expect(pickLevel('relative/dir')).rejects.toThrow(/absolute/)
    await expect(pickLevel(join(base, 'nope'))).rejects.toThrow(/not an existing directory/)
  })

  it('enumerates drive roots on win32 and a home anchor otherwise', () => {
    const roots = pickRoots()
    expect(roots.length).toBeGreaterThan(0)
    // Every root is absolute; the home anchor is always present.
    expect(roots.some(entry => entry.name.startsWith('~'))).toBe(true)
  })
})

describe('pick routes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pick-routes-'))
  const sub = join(base, 'sub')
  mkdirSync(sub)
  const configPath = join(base, 'dirs.json')
  const previousConfig = process.env.DSH_CODEX_PROJECT_CONFIG
  const store = new DirsStore()
  const registry: WorkspaceRegistryFace = { list: () => [] }

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.DSH_CODEX_PROJECT_CONFIG
    else process.env.DSH_CODEX_PROJECT_CONFIG = previousConfig
    rmSync(configPath, { force: true })
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('serves the browsable roots', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    const response = await dirsApi(store, registry, 'GET', '/codex-project/api/pick-roots', undefined)
    expect(response.status).toBe(200)
    const body = response.body as { ok: boolean; roots: Array<{ name: string; path: string }> }
    expect(body.ok).toBe(true)
    expect(body.roots.length).toBeGreaterThan(0)
  })

  it('lists one directory level over the pick-list route', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    const url = `/codex-project/api/pick-list?path=${encodeURIComponent(base)}`
    const response = await dirsApi(store, registry, 'GET', url, undefined)
    expect(response.status).toBe(200)
    const body = response.body as { ok: boolean; path: string; dirs: Array<{ name: string }> }
    expect(body.ok).toBe(true)
    expect(body.path).toBe(base)
    expect(body.dirs.map(entry => entry.name)).toContain('sub')
  })

  it('rejects a missing pick-list path with a 400', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    const url = `/codex-project/api/pick-list?path=${encodeURIComponent(join(base, 'gone'))}`
    const response = await dirsApi(store, registry, 'GET', url, undefined)
    expect(response.status).toBe(400)
  })

  it('405s a non-GET pick-list', async () => {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    const response = await dirsApi(store, registry, 'POST', '/codex-project/api/pick-list', {})
    expect(response.status).toBe(405)
  })
})

describe('normalizePickPath (win32 Git-Bash roots)', () => {
  it('maps /c /d and nested Git-Bash roots to native drive paths', () => {
    expect(normalizePickPath('/c', 'win32')).toBe('C:\\')
    expect(normalizePickPath('/d', 'win32')).toBe('D:\\')
    expect(normalizePickPath('/c/Users/me', 'win32')).toBe('C:\\Users\\me')
    expect(normalizePickPath('/c/Program Files', 'win32')).toBe('C:\\Program Files')
    // lowercase drive letter → uppercase, forward slashes → backslashes.
    expect(normalizePickPath('/d/foo/bar', 'win32')).toBe('D:\\foo\\bar')
  })

  it('accepts native windows drive forms', () => {
    expect(normalizePickPath('C:\\Users\\me', 'win32')).toBe('C:\\Users\\me')
    expect(normalizePickPath('c:/users/me', 'win32')).toBe('C:\\users\\me')
    expect(normalizePickPath('C:', 'win32')).toBe('C:\\')
    expect(normalizePickPath('c:\\', 'win32')).toBe('C:\\')
  })

  it('returns undefined for non-absolute or empty input on win32', () => {
    expect(normalizePickPath('', 'win32')).toBeUndefined()
    expect(normalizePickPath('relative/dir', 'win32')).toBeUndefined()
    expect(normalizePickPath('Users/me', 'win32')).toBeUndefined()
  })

  it('passes absolute paths through on posix and rejects the rest', () => {
    expect(normalizePickPath('/home/me', 'linux')).toBe('/home/me')
    expect(normalizePickPath('/c/Users', 'linux')).toBe('/c/Users') // a real posix path, not a drive
    expect(normalizePickPath('home/me', 'linux')).toBeUndefined()
  })
})
