/**
 * Session context reminder: make the model aware of the additional
 * writable-dir record it works under. Folded into the step that claims the
 * session's user messages, and only when the effective reminder CHANGED since
 * the last one this plugin put on the session surface — a fresh session gets
 * one seeding reminder, then nothing further until a directory is added
 * (add-dir) or removed (the 编辑工作区 dialog) or the 主要 choice changes, each
 * of which changes the text and thus re-folds on the next user message. No
 * change event is needed: the reminder text is derived purely from the
 * directory set and the primary, so either change produces changed text.
 *
 * The reminder carries one short `<system-reminder>` block listing the
 * workspace's directories — the user's 主要 root first when one is set, then
 * the session workspace, then the rest — and a note that every listed
 * directory is governed by the same workspace-write permission (the plugin
 * grants a workspace-level SID on every surviving root, so no root exceeds the
 * session workspace's boundary and the model can treat them uniformly).
 * Because the primary is part of the text, 「设为主要」 re-folds the reminder on
 * the next user message the same way adding or removing a directory does. A
 * vanished dir is skipped silently. AGENTS.md summaries are NOT injected: file
 * content is the model's own tool work.
 *
 * Dedup: `hasIdenticalInjection` walks the real session surface (the
 * `surface.nodes` sequences resolved through `eventAt`) for the newest
 * plugin reminder from this plugin and compares its content. A resumed
 * session whose surface already carries an identical reminder is not
 * re-seeded; one carrying a stale (different) list gets the current text
 * folded after its next user message. Plain, identical messages between
 * user turns do not stack.
 * @module dsh-codex-project/context-injection
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { loadWorkspaceDirs, matchingWorkspace, requireCanonicalDirectory, tryCanonicalDirectory } from './dirs-config.ts'
import type { WorkspaceDirs } from './dirs-config.ts'

/** The plugin's identity in injected message sources. */
export const PLUGIN_NAME = 'dsh-codex-project'

/** The dsh `<system-reminder>` framing convention (agent-instructions, tool-skill). */
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/**
 * The minimal live-session face the fold reads: header cwd, surface
 * sequences, and an event-at resolver. Structural mirror of the real
 * `Session` (`agent.session`): the core exposes NO `events` array — surface
 * node seqs are resolved one-by-one through `eventAt`. Tests build a fixture
 * with the same shape, so a bug here cannot hide behind a fake-only field.
 */
export interface InjectionSession {
   readonly header: { readonly cwd?: string }
   readonly surface: { readonly nodes: readonly number[] }
   /** Resolve one surface-node sequence number to its event (real `Session.eventAt`). */
   eventAt(seq: number): SessionEvent | undefined
}

/**
 * The model-facing `<system-reminder>` text describing one workspace's
 * writable set: the primary root first (when the user picked one), then the
 * session workspace, then the remaining additional dirs in configured order,
 * followed by a sentence noting every listed directory shares the session
 * workspace's permissions (the plugin grants a workspace-level SID on each
 * surviving root — no root exceeds the session workspace's boundary, so the
 * model can treat them uniformly). Roots are shown in their configured
 * (canonical-ish) spelling; the current-workspace marker compares canonical
 * forms, and a primary whose directory vanished is dropped rather than
 * leading the list. Directory list plus the permission hint — no file
 * contents, missing dirs silently skipped. English copy on purpose — the
 * reminder is model-facing prompt text.
 * @param workspaceId - the owning workspace.
 * @param record - the workspace's persisted record.
 * @param canonicalWorkspace - the canonical session workspace.
 * @returns the reminder text, one `<system-reminder>` block.
 */
export function composeWorkspaceContextText(
  workspaceId: string,
  record: WorkspaceDirs,
  canonicalWorkspace: string,
): string {
  const anchor = `- ${record.path}${tryCanonicalDirectory(record.path) === canonicalWorkspace ? ' (current session workspace)' : ''}`
  const surviving = record.dirs.filter(dir => tryCanonicalDirectory(dir) !== undefined)
  const configured = record.primary
  // Only a surviving dir can lead: compare canonical forms so a different
  // spelling of the same path still matches.
  const primary = configured === undefined
    ? undefined
    : surviving.find(dir => tryCanonicalDirectory(dir) === tryCanonicalDirectory(configured))
  const lines = primary === undefined
    ? [anchor, ...surviving.map(dir => `- ${dir}`)]
    : [`- ${primary} (primary workspace)`, anchor, ...surviving.filter(dir => dir !== primary).map(dir => `- ${dir}`)]
  return [
    REMINDER_OPEN,
    `[Workspace sharing] The current session workspace (${workspaceId}) is associated with these directories:`,
    ...lines,
    'Every directory listed is governed by the same permissions as the session workspace.',
    REMINDER_CLOSE,
  ].join('\n')
}

/**
 * Whether the session surface already carries this exact reminder as the
 * MOST RECENT injection from this plugin. Walks the surface from the tail
 * backwards and stops at the first plugin `user/message` tagged with
 * `PLUGIN_NAME`, comparing its content. Because the reminder text is a pure
 * function of the directory set, an identical newest reminder means the
 * directory set did not change since the last injection → skip; a different
 * one (a stale list on a resumed session, or a set that changed after
 * add-dir / the manage dialog) means the model is out of date → fold again.
 * @param session - the live session (real `Session`: surface nodes resolved via `eventAt`).
 * @param message - the reminder message about to be folded in.
 * @returns true when an equivalent reminder is already the newest one.
 */
export function hasIdenticalInjection(session: InjectionSession, message: UserMessage): boolean {
  for (const seq of session.surface.nodes.toReversed()) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source?.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) continue
    // The newest plugin reminder is the authoritative prior state.
    return JSON.stringify(event.data.content) === JSON.stringify(message.content)
  }
  return false
}

/**
 * Build the reminder for a session cwd, or `undefined` when the workspace is
 * outside every record / has no surviving additional dir.
 * @param cwd - the session's working directory.
 * @returns the reminder user message, or undefined when nothing applies.
 */
export function computeWorkspaceReminder(cwd: string | undefined): UserMessage | undefined {
  if (cwd === undefined) return undefined
  const canonicalWorkspace = requireCanonicalDirectory('session workspace', cwd)
  const match = matchingWorkspace(loadWorkspaceDirs(), canonicalWorkspace)
  if (match === undefined || match.roots.length <= 1) return undefined
  const records = loadWorkspaceDirs()
  const record = records[match.workspaceId]
  if (record === undefined) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: composeWorkspaceContextText(match.workspaceId, record, canonicalWorkspace) }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  })
}

/**
 * Fold the reminder into a proposed step, right after the claimed batch, but
 * only when the directory set changed since the last injection — i.e. the
 * reminder differs from the newest plugin reminder already on the surface.
 * A fresh session seeds once; an unchanged set across later user messages is
 * a no-op; add-dir or the manage dialog changes the set and the next user
 * message re-folds. No-op when the step is rejected, claims no user
 * messages, no record matches, or the identical reminder is already the
 * newest one.
 * @param decision - the pre-step decision produced so far.
 * @param claimed - the messages this step claimed from the inbox.
 * @param session - the live session (dedup via `eventAt`).
 * @returns the (possibly rewritten) decision.
 */
export function foldWorkspaceContext(
  decision: PreStepDecision,
  claimed: readonly UserMessage[],
  session: InjectionSession,
): PreStepDecision {
  if (decision.kind !== 'enter') return decision
  if (claimed.length === 0) return decision
  const reminder = computeWorkspaceReminder(session.header.cwd)
  if (reminder === undefined) return decision
  if (hasIdenticalInjection(session, reminder)) return decision
  const lastClaimedIndex = decision.messages.findLastIndex(message => claimed.includes(message))
  const insertAt = lastClaimedIndex >= 0 ? lastClaimedIndex + 1 : decision.messages.length
  return { kind: 'enter', messages: decision.messages.toSpliced(insertAt, 0, reminder) }
}
