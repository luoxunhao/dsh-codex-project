/**
 * Project file search + upload host tests: the recursive file-name search over
 * the project roots (search) and the fenced upload of base64 files under a
 * project root (upload), both through the dirsApi route dispatch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { DirsStore } from '../src/dirs-store.ts'
import type { WorkspaceRegistryFace } from '../src/dirs-store.ts'
import { dirsApi } from '../src/dirs-api.ts'

const enc = encodeURIComponent

describe('project search + upload routes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-search-'))
  const rootA = join(base, 'proj')
  const shared = join(base, 'shared')
  mkdirSync(join(rootA, 'src'), { recursive: true })
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(rootA, 'README.md'), 'a')
  writeFileSync(join(rootA, 'src', 'index.ts'), 'b')
  writeFileSync(join(shared, 'helper.ts'), 'c')
  const configPath = join(base, 'dirs.json')
  const previousConfig = process.env.DSH_CODEX_PROJECT_CONFIG
  const store = new DirsStore()
  const registry: WorkspaceRegistryFace = {
    list: () => [
      { id: 'w', path: rootA },
      { id: 's', path: shared },
    ],
  }
  const api = (method: string, pathname: string, body?: unknown) =>
    dirsApi(store, registry, method, pathname, body)

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.DSH_CODEX_PROJECT_CONFIG
    else process.env.DSH_CODEX_PROJECT_CONFIG = previousConfig
    rmSync(configPath, { force: true })
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  /** A record: rootA is the main root, `shared` an additional dir. */
  async function seedProject(): Promise<void> {
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
    await api('PUT', '/codex-project/api/dirs', { workspaceId: 'w', dirs: [shared] })
  }

  it('searches matching file names across the project roots', async () => {
    await seedProject()
    // '.ts' matches src/index.ts (in the main root) AND shared/helper.ts (in an
    // additional dir) — proving the walk covers every project root.
    const response = await api('GET', `/codex-project/api/search?cwd=${enc(rootA)}&query=${enc('.ts')}`)
    expect(response.status).toBe(200)
    const body = response.body as { ok: boolean; results: Array<{ path: string; name: string }> }
    expect(body.ok).toBe(true)
    const names = body.results.map(r => r.path)
    expect(names).toContain(join(rootA, 'src', 'index.ts'))
    expect(names).toContain(join(shared, 'helper.ts'))
    expect(names).not.toContain(join(rootA, 'README.md'))
  })

  it('matches case-insensitively by basename anywhere in the tree', async () => {
    await seedProject()
    const response = await api('GET', `/codex-project/api/search?cwd=${enc(rootA)}&query=${enc('index')}`)
    const names = (response.body as { results: Array<{ path: string }> }).results.map(r => r.path)
    expect(names).toContain(join(rootA, 'src', 'index.ts'))
    expect(names).not.toContain(join(rootA, 'README.md'))
  })

  it('returns empty for an empty/whitespace query', async () => {
    await seedProject()
    const response = await api('GET', `/codex-project/api/search?cwd=${enc(rootA)}&query=${enc('   ')}`)
    expect((response.body as { results: unknown[] }).results).toEqual([])
  })

  it('uploads files (creating parent dirs) into a project root', async () => {
    await seedProject()
    const payload = {
      cwd: rootA,
      dir: rootA,
      files: [
        { path: 'lib/util.js', contentBase64: Buffer.from('console.log(1)').toString('base64') },
      ],
    }
    const response = await api('POST', '/codex-project/api/upload', payload)
    expect(response.status).toBe(200)
    expect((response.body as { count: number }).count).toBe(1)
    expect(readFileSync(join(rootA, 'lib', 'util.js'), 'utf8')).toBe('console.log(1)')
  })

  it('refuses an upload whose relative path escapes the target dir', async () => {
    await seedProject()
    const response = await api('POST', '/codex-project/api/upload', {
      cwd: rootA,
      dir: rootA,
      files: [{ path: '../../evil.txt', contentBase64: 'eA==' }],
    })
    expect(response.status).toBe(400)
  })

  it('refuses an upload target directory outside the project roots', async () => {
    await seedProject()
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    const response = await api('POST', '/codex-project/api/upload', {
      cwd: rootA,
      dir: outside,
      files: [{ path: 'x.txt', contentBase64: 'eA==' }],
    })
    expect(response.status).toBe(403)
  })

  it('405s non-GET search and non-POST upload', async () => {
    await seedProject()
    expect((await api('POST', '/codex-project/api/search', {})).status).toBe(405)
    expect((await api('GET', '/codex-project/api/upload')).status).toBe(405)
  })
})
