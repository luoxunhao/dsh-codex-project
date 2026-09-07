/**
 * /adddir command tests: picker capability branches (native pick / cancel /
 * non-native / absent), workspace resolution, validation, and idempotence —
 * the pure defineAdddirCommand over injected deps.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defineAdddirCommand, type AdddirCommandDeps, type AdddirCommandResult } from '../src/adddir-command.ts'
import { DirsStore } from '../src/dirs-store.ts'

const base = mkdtempSync(join(tmpdir(), 'dsh-adddir-cmd-'))
const workspacePath = join(base, 'ws')
const dirA = join(base, 'dir-a')
const missingDir = join(base, 'missing')
const configPath = join(base, 'dirs.json')
const previousConfig = process.env.DSH_CODEX_PROJECT_CONFIG

type PickerResult = { kind: 'native'; value: string | null } | { kind: 'browse' }

function makeDeps(picker: PickerResult | undefined):
  { deps: AdddirCommandDeps; store: DirsStore } {
  const store = new DirsStore()
  const deps: AdddirCommandDeps = {
    resolveWorkspaceId: cwd => (cwd === workspacePath ? 'w1' : undefined),
    picker: () => picker === undefined
      ? undefined
      : {
        capability: () => picker.kind === 'native'
          ? { kind: 'native', pick: async () => picker.value }
          : { kind: 'browse' },
      },
    store,
  }
  return { deps, store }
}

function run(deps: AdddirCommandDeps, cwd = workspacePath): Promise<AdddirCommandResult> {
  const command = defineAdddirCommand(deps)
  return Promise.resolve(command.handler({
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } } as unknown as Agent,
  } as never))
}

describe('/adddir command', () => {
  beforeEach(() => {
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(dirA, { recursive: true })
    process.env.DSH_CODEX_PROJECT_CONFIG = configPath
  })

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.DSH_CODEX_PROJECT_CONFIG
    else process.env.DSH_CODEX_PROJECT_CONFIG = previousConfig
    rmSync(configPath, { force: true })
  })

  it('registers under the name adddir', () => {
    const { deps } = makeDeps({ kind: 'native', value: dirA })
    expect(defineAdddirCommand(deps).name).toBe('adddir')
  })

  it('picks a directory and adds it to the session workspace', async () => {
    const { deps, store } = makeDeps({ kind: 'native', value: dirA })
    await store.anchor('w1', workspacePath)
    const result = await run(deps)
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining(dirA) })
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [dirA] } })
  })

  it('does not write when the operator cancels the picker', async () => {
    const { deps, store } = makeDeps({ kind: 'native', value: null })
    await store.anchor('w1', workspacePath)
    const result = await run(deps)
    expect(result).toEqual({ kind: 'success', text: 'cancelled' })
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [] } })
  })

  it('reports an error when no directory picker is composed', async () => {
    const { deps } = makeDeps(undefined)
    const result = await run(deps)
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('no directory picker is available') })
  })

  it('reports an error for a non-native (browse) picker', async () => {
    const { deps } = makeDeps({ kind: 'browse' })
    const result = await run(deps)
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('not a native chooser') })
  })

  it('rejects when the session is outside every registered workspace', async () => {
    mkdirSync(join(base, 'other'), { recursive: true })
    const { deps } = makeDeps({ kind: 'native', value: dirA })
    const result = await run(deps, join(base, 'other'))
    expect(result).toMatchObject({ kind: 'error', text: 'session is not inside a registered workspace' })
  })

  it('rejects a call whose agent has no cwd', async () => {
    const { deps } = makeDeps({ kind: 'native', value: dirA })
    const command = defineAdddirCommand(deps)
    const result = await command.handler({
      signal: new AbortController().signal,
      agent: { session: { header: {} } } as unknown as Agent,
    } as never)
    expect(result).toMatchObject({ kind: 'error', text: 'session has no working directory' })
  })

  it('rejects a pick that is not an existing directory', async () => {
    const { deps } = makeDeps({ kind: 'native', value: missingDir })
    const result = await run(deps)
    expect(result).toMatchObject({ kind: 'error', text: `not an existing directory: ${missingDir}` })
  })

  it('is idempotent: adding an existing dir keeps the list unchanged', async () => {
    const { deps, store } = makeDeps({ kind: 'native', value: dirA })
    await store.anchor('w1', workspacePath)
    await store.setDirs('w1', [dirA])
    const result = await run(deps)
    expect(result).toEqual({ kind: 'success', text: expect.stringContaining(dirA) })
    expect(await store.load()).toMatchObject({ w1: { path: workspacePath, dirs: [dirA] } })
  })
})
