import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/** Read the package manifest the tests guard. */
function manifest(): { dependencies?: Record<string, string>, peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
}

describe('dsh-codex-project plugin export shape', () => {
  it('exports the loader plugin shape', () => {
    expect(plugin.name).toBe('@luoxunhao/dsh-codex-project')
    expect(plugin.inject).toContain('webServer')
    expect(typeof plugin.apply).toBe('function')
  })
})

describe('dependency surface (what a profile installs)', () => {
  /**
   * The runner is spawned as its own `node` process, so it resolves through
   * plain Node and cannot use the loader's fallback to the host's copy.
   */
  const RUNNER_ONLY = new Set(['@deepseek-ai/dsh-sandbox-windows-acl'])

  it('keeps host-provided DSH packages out of dependencies', () => {
    const { dependencies = {} } = manifest()
    // A second copy in the profile's hoisted node_modules gives our bundle a
    // DIFFERENT module instance than the host's. dsh-tools keys its runtime
    // scheduler on a module-level Symbol, so dsh-agent-loop reads
    // `ctx.tools[TOOL_RUNTIME_SCHEDULER]` as undefined and every tool call in
    // every conversation dies with "Cannot read properties of undefined
    // (reading 'prepare')" — while the host still boots and the plugin UI
    // still works. Peers let the loader fall back to the host's own copy.
    const offenders = Object.keys(dependencies)
      .filter(name => name.startsWith('@deepseek-ai/') && !RUNNER_ONLY.has(name))
    expect(offenders, `these belong in peerDependencies, not dependencies: ${offenders.join(', ')}`).toEqual([])
  })

  it('declares the loader-resolved host packages as peers', () => {
    const { dependencies = {}, peerDependencies = {} } = manifest()
    // Measured runtime imports of the two bundles the DSH loader executes
    // (lib/index.js and lib/fs.js). Peers are what let the loader fall back to
    // the host's own copy instead of a second instance in the profile.
    const LOADER_RESOLVED = [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-fs-sandbox',
      '@deepseek-ai/dsh-sandbox',
    ]
    const missing = LOADER_RESOLVED.filter(name => !(name in peerDependencies))
    expect(missing, `missing peer declaration: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps the runner-only host package installable on disk', () => {
    const { dependencies = {} } = manifest()
    // lib/runner.js is spawned as its own node process: plain resolution, no
    // loader fallback, so this one must ship as a real dependency.
    expect(dependencies).toHaveProperty('@deepseek-ai/dsh-sandbox-windows-acl')
  })

  it('pins one host baseline across every dsh-* peer', () => {
    const { peerDependencies = {} } = manifest()
    const ranges = new Set(Object.entries(peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, range]) => range))
    // Caret ranges never match prereleases, so a per-package drift silently
    // rejects the host the plugin was validated against.
    expect(ranges.size, `peer ranges drifted apart: ${[...ranges].join(', ')}`).toBe(1)
  })
})
