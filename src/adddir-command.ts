/**
 * The `/adddir` human command: the operator-facing counterpart of the
 * `add_dir` model tool. The operator types `/adddir` in the composer, a
 * native directory picker opens on the host, and the chosen folder joins the
 * ADDITIONAL writable dirs of the active session's workspace — no approval
 * prompt (the operator explicitly picked it). Registered through the dsh
 * host `commands` service as a plain global command (name `adddir`, no
 * leading slash), which is enough for it to appear in the composer `/` menu
 * and run (the browser command catalog is pulled live from the host).
 *
 * Picker: reads the host `ctx.directoryPicker` seam. Only the `native`
 * capability (an OS chooser on the host display) fits a no-arg command; a
 * `browse` backend or an absent service yields a clear error instead of
 * guessing. dsh model tools are `add_dir` (underscore); the matching user
 * command is `/adddir`.
 * @module dsh-codex-project/adddir-command
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'

import { DirsStoreError } from './dirs-store.ts'
import type { DirsStore } from './dirs-store.ts'

/* ---- Structural faces of the host services this command uses. The real
 *   module augmentations (@deepseek-ai/dsh-commands, dsh-host-directory-picker)
 *   are not installed in this standalone plugin workspace, so the slices the
 *   command consumes are restated structurally — the same pattern the rest of
 *   the plugin uses (dirs-store.ts WorkspaceRegistryFace, client context.ts).
 *   Only the used members are mirrored; drift is contained to this file.
 * ------------------------------------------------------------------ */

/** One resolved slash command result (host @deepseek-ai/dsh-commands). */
export type AdddirCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Invocation passed to a registered command handler. */
export interface AdddirCommandInvocation {
  /** Exact agent whose UI received the command. */
  readonly agent: Agent
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** The command registration the `commands` service accepts (host face). */
export interface AdddirCommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: AdddirCommandInvocation) =>
    AdddirCommandResult | Promise<AdddirCommandResult>
}

/** The `commands` host service face (register only). */
export interface CommandsServiceFace {
  register(definition: AdddirCommandDefinition): () => void
}

/** The native directory-picker capability (host seam). */
export interface NativeDirectoryPicker {
  readonly kind: 'native'
  pick(signal: AbortSignal): Promise<string | null>
}

/** The `directoryPicker` host service face (capability only). */
export interface DirectoryPickerServiceFace {
  capability(): NativeDirectoryPicker | { readonly kind: 'browse' } | { readonly kind: string }
}

/** Deps the `/adddir` command needs (wired in index.ts). */
export interface AdddirCommandDeps {
  /** Resolve the owning workspace id of a session cwd (shared with the model tool). */
  resolveWorkspaceId(cwd: string): string | undefined
  /** The host directory picker, or undefined when none is composed. */
  picker(): DirectoryPickerServiceFace | undefined
  /** Persist the additional writable dirs. */
  store: DirsStore
}

/** Build the host `/adddir` command. */
export function defineAdddirCommand(deps: AdddirCommandDeps): AdddirCommandDefinition {
  return {
    name: 'adddir',
    description: 'Open a directory picker and add the folder to this session\'s additional writable directories.',
    handler: async ({ agent, signal }): Promise<AdddirCommandResult> => {
      const cwd = agent?.session.header.cwd
      if (cwd === undefined) return { kind: 'error', text: 'session has no working directory' }
      const workspaceId = deps.resolveWorkspaceId(cwd)
      if (workspaceId === undefined) {
        return { kind: 'error', text: 'session is not inside a registered workspace' }
      }
      const picker = deps.picker()
      if (picker === undefined) {
        return { kind: 'error', text: 'no directory picker is available in this session' }
      }
      const capability = picker.capability()
      if (capability.kind !== 'native') {
        return { kind: 'error', text: `directory picker is not a native chooser (serves ${capability.kind})` }
      }
      // After the kind guard the value is the native capability; the structural
      // face's non-native arm is opaque so narrow by the checked literal.
      const native = capability as NativeDirectoryPicker
      let picked: string | null
      try {
        picked = await native.pick(signal)
      } catch (error) {
        return { kind: 'error', text: `directory picker failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (picked === null) return { kind: 'success', text: 'cancelled' }
      if (!isAbsolute(picked)) return { kind: 'error', text: `picked path is not absolute: ${picked}` }
      let isDirectory = false
      try {
        isDirectory = statSync(picked).isDirectory()
      } catch {
        // Missing or unreadable → reject below.
      }
      if (!isDirectory) return { kind: 'error', text: `not an existing directory: ${picked}` }
      try {
        // Auto-anchors the workspace on first use (same primitive the manage
        // dialog and add_dir tool converge on), so a fresh workspace never
        // fails with an unanchored-record error.
        const saved = await deps.store.addDir(workspaceId, cwd, picked)
        return { kind: 'success', text: `Added ${picked}.\nAdditional writable directories: ${saved.dirs.join(', ') || '(none)'}` }
      } catch (error) {
        if (error instanceof DirsStoreError) return { kind: 'error', text: error.message }
        throw error
      }
    },
  }
}
