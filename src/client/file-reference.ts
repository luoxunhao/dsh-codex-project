/**
 * The `@` reference source of the 项目文件夹 project. Referencing a file no
 * longer drops plain text into the composer — it injects a proper reference
 * chip through the conversation input's scoped `slash/input-insert-reference`
 * event. The chip shows the FILE NAME (`label`) in the composer, and on submit
 * the registered source's codec serializes the ABSOLUTE path (inline-code
 * form, the harness's recognized file-tool path) into the model context.
 *
 * The source is ALSO a real `@`-menu source, shaped after the harness's own
 * `ui-reference` source (`packages/client/ui-reference`): it browses the
 * project — main root plus every shared additional dir (cross-drive) — one
 * directory level at a time. A directory row carries `drill`, so Tab (or the
 * row chevron) descends into it and keeps the menu open; a drilled listing
 * publishes breadcrumbs (`header`) so the user can climb back out. That
 * level-by-level descent is what core discovery cannot do: core discovery is
 * rooted at the session cwd alone, so shared dirs outside it stay invisible to
 * `@` without this source.
 *
 * Descent rides the DRAFT TEXT, exactly like the harness: a drill pick returns
 * `{ text, continue: true }`, the pipeline rewrites the trigger token and
 * re-queries every source with the deeper query. The text is the absolute path
 * in `@path/` (or `@"path/` when it contains spaces) form — the project is
 * multi-rooted, so a bare relative path could not name a destination.
 *
 * All types are restated structurally — the client bundle's purity gate
 * forbids value-importing the input-trigger package.
 * @module dsh-codex-project/client/file-reference
 */

import type { ProjectView, SpacesApi } from './api.ts'
import type {
  ClientRuntimeContext,
  DraftInput,
  FileReferenceInsert,
  FileReferenceSpan,
  SidebarTabScope,
} from './context.ts'
import { basename, relativePath, resolvePath, samePath } from './paths.ts'

/** The registered source name; the chip's `source` routes here for serialization. */
export const FILE_REF_SOURCE = 'codex-project:file'

/** The conversation input event the composer hub listens for on a session scope. */
const INSERT_REFERENCE_EVENT = 'slash/input-insert-reference'

/** Maximum rows this source contributes for one query (mirrors core's 20). */
const MAX_CANDIDATES = 20

/** Control characters and quotes the trigger grammar cannot write back. */
const UNREPRESENTABLE_RE = /[\u0000-\u001f\u007f-\u009f"]/u

/** The trailing slash that marks a directory reference for the model. */
const DIRECTORY_SUFFIX = '/'

/** One row's opaque pick payload: what it is, where it lives, and its trigger text. */
export interface ProjectReferenceValue {
  kind: 'dir' | 'file'
  /** Absolute path, separators normalized to `/`. */
  path: string
  /** The trigger text this row writes back (drill text or chip mention). */
  mention: string
}

/**
 * The source's dependencies: the project API and a session→cwd projection.
 * Both are supplied at registration so the source stays a pure function of its
 * inputs under test.
 */
export interface ProjectReferenceDeps {
  api: Pick<SpacesApi, 'project' | 'listDir'>
  /** The session's working directory, or undefined while the projection is cold. */
  cwdFor?(sessionId: string): string | undefined
}

/** The project roots one session sees: the anchor plus surviving shared dirs. */
export interface ProjectRoots {
  cwd: string
  /** Main root (== the session cwd). */
  main: string
  /** Additional shared directories, in configured order. */
  dirs: readonly string[]
}

/** One menu candidate (structural mirror of the input-trigger contract). */
export interface ProjectCandidate {
  name: string
  description?: string
  icon?: 'file' | 'folder'
  section?: string
  value: string
  drill?: boolean
}

/** One breadcrumb step (structural mirror of the input-trigger contract). */
export interface ProjectCrumb {
  label: string
  value: string
  current?: boolean
}

/**
 * Split one trigger query into the directory being listed and the fragment
 * typed after its last separator — core's `WorkspaceFileSearch.list` protocol,
 * where a slash-bearing query IS the request to descend.
 * @param query - path text following `@` or `@"`.
 */
export function splitQuery(query: string): { directory: string; fragment: string } {
  const normalized = query.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return { directory: '', fragment: normalized }
  return { directory: normalized.slice(0, slash + 1), fragment: normalized.slice(slash + 1) }
}

/**
 * Render one destination as trigger text, following core's `formatFileMention`
 * grammar: a directory keeps its trailing slash open so the next query can
 * descend another level, and a path containing whitespace is quoted. Control
 * characters and quotes cannot be written back at all.
 * @param path - absolute path, separators normalized to `/`.
 * @param isDirectory - whether the destination is a directory.
 * @param quoted - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion text, or undefined when the grammar cannot represent it.
 */
export function formatProjectMention(
  path: string,
  isDirectory: boolean,
  quoted = false,
): string | undefined {
  const withSlash = isDirectory ? `${normalize(path)}/` : path
  if (UNREPRESENTABLE_RE.test(withSlash)) return undefined
  if (!quoted && !/\s/u.test(withSlash)) return `@${withSlash}`
  return isDirectory ? `@"${withSlash}` : `@"${withSlash}"`
}

/** Normalize one absolute path to forward slashes, dropping trailing separators. */
export function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '')
}

/** Whether `path` sits inside (or equals) `root`, per the platform's case convention. */
function isUnder(root: string, path: string): boolean {
  const parent = normalize(root)
  const child = normalize(path)
  if (samePath(parent, child)) return true
  const prefix = `${parent}/`
  return child.length > prefix.length && samePath(child.slice(0, prefix.length), prefix)
}

/** The root an absolute path belongs to, or undefined when it escapes the project. */
export function rootFor(roots: ProjectRoots, path: string): string | undefined {
  return [roots.main, ...roots.dirs].find(root => isUnder(root, path))
}

/**
 * Resolve the directory a query names against the project roots. A query is
 * absolute once a drill wrote one back; a hand-typed query is relative and
 * resolves under the main root. Paths that leave the project — after `..` is
 * folded — yield undefined: the host refuses them anyway, and this source
 * simply offers nothing.
 * @param roots - the project roots.
 * @param directory - the query's directory part (empty at the project root).
 */
export function resolveQueryDirectory(roots: ProjectRoots, directory: string): string | undefined {
  const text = directory.replaceAll('\\', '/')
  if (text === '') return normalize(roots.main)
  const resolved = normalize(resolvePath(normalize(roots.main), text))
  return rootFor(roots, resolved) === undefined ? undefined : resolved
}

/** The display name of one project root; the main root is marked as such. */
function rootLabel(root: string, roots: ProjectRoots): string {
  return samePath(root, roots.main) ? `${basename(root)} (主)` : basename(root)
}

/**
 * The breadcrumb of a drilled listing: one step from the containing root down
 * to the directory being listed. Only a drill produces one — a path the user
 * typed carries its own context in the draft, while a drill replaced the text
 * they were reading and owes them the way back (core's `crumbsFor` rule).
 * @param roots - the project roots.
 * @param query - the live trigger query.
 * @param quoted - whether the active token is an open quoted path.
 * @param drilled - whether a drill pick, rather than typing, produced the query.
 * @returns the crumbs, or undefined when this listing needs no header.
 */
export function crumbsFor(
  roots: ProjectRoots,
  query: string,
  quoted: boolean,
  drilled: boolean,
): readonly ProjectCrumb[] | undefined {
  if (!drilled) return undefined
  const { directory } = splitQuery(query)
  if (directory === '') return undefined
  const target = resolveQueryDirectory(roots, directory)
  if (target === undefined) return undefined
  const root = rootFor(roots, target)
  if (root === undefined) return undefined
  const rootPath = normalize(root)
  const rootMention = formatProjectMention(rootPath, true, quoted)
  if (rootMention === undefined) return undefined
  const crumbs: ProjectCrumb[] = [{
    label: rootLabel(root, roots),
    value: encodeValue({ kind: 'dir', path: rootPath, mention: rootMention }),
  }]
  const relative = relativePath(rootPath, target)
  const segments = relative
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  for (const [index, segment] of segments.entries()) {
    const path = `${rootPath}/${segments.slice(0, index + 1).join('/')}`
    const mention = formatProjectMention(path, true, quoted)
    // A trail whose steps cannot all be written back would send the user
    // somewhere they did not click; show no header instead.
    if (mention === undefined) return undefined
    crumbs.push({
      label: segment,
      value: encodeValue({ kind: 'dir', path, mention }),
      ...(index === segments.length - 1 ? { current: true } : {}),
    })
  }
  return crumbs
}

/** Encode one row's payload as its opaque candidate value. */
function encodeValue(value: ProjectReferenceValue): string {
  return JSON.stringify(value)
}

/** Decode one row's payload, tolerating rows this source did not produce. */
export function decodeValue(value: string | undefined): ProjectReferenceValue | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<ProjectReferenceValue>
    if (parsed.kind !== 'dir' && parsed.kind !== 'file') return undefined
    if (typeof parsed.path !== 'string' || typeof parsed.mention !== 'string') return undefined
    return { kind: parsed.kind, path: parsed.path, mention: parsed.mention }
  } catch {
    return undefined
  }
}

/** Rank one entry name against a fragment; `undefined` drops the row. */
function score(name: string, fragment: string): number | undefined {
  if (fragment === '') return 0
  const needle = fragment.toLowerCase()
  const target = name.toLowerCase()
  if (target === needle) return 400
  if (target.startsWith(needle)) return 300
  if (target.includes(needle)) return 200
  return undefined
}

/** Order two level rows: score, then directories first, then name. */
function compareRows(
  a: { name: string; isDir: boolean; score: number },
  b: { name: string; isDir: boolean; score: number },
): number {
  return b.score - a.score
    || Number(b.isDir) - Number(a.isDir)
    || a.name.localeCompare(b.name)
}

/**
 * Build the project `@` source: one directory level at a time over the session
 * project's main root plus every shared additional dir, with drill-down
 * descent and breadcrumbs — the multi-root answer to core's cwd-rooted
 * `@files`.
 *
 * The source serves the session that opened the menu and nothing else: its
 * roots are the project anchored at that session's cwd, resolved exactly like
 * the 项目文件夹 tab (`/project` + `/list`, fenced to the project). When no
 * project anchors the cwd, the source contributes nothing — like core
 * discovery, an unanchored session sees no project files.
 * @param api - the project API.
 * @param deps - optional source dependencies (a session→cwd projection).
 */
export function createFileReferenceSource(
  api: SpacesApi | undefined,
  deps: { cwdFor?(sessionId: string): string | undefined } = {},
): unknown {
  const refDeps: ProjectReferenceDeps = {
    api: {
      project: async (cwd) => api?.project(cwd) ?? null,
      listDir: async (cwd, path) => {
        const listing = await api?.listDir(cwd, path)
        return listing ?? { path, entries: [], truncated: false }
      },
    },
    ...(deps.cwdFor === undefined ? {} : { cwdFor: deps.cwdFor }),
  }
  /** Per-session root cache; `header` is synchronous and reads it. */
  const rootsBySession = new Map<string, ProjectRoots>()

  /**
   * Resolve one session's project roots, or undefined when the session cwd is
   * still cold or no record anchors it.
   */
  const rootsFor = async (sessionId: string): Promise<ProjectRoots | undefined> => {
    const cached = rootsBySession.get(sessionId)
    if (cached !== undefined) return cached
    const cwd = refDeps.cwdFor?.(sessionId)
    if (cwd === undefined || cwd === '') return undefined
    let project: ProjectView | null = null
    try {
      project = await refDeps.api.project(cwd)
    } catch {
      return undefined
    }
    if (project === null) return undefined
    const roots: ProjectRoots = {
      cwd,
      main: project.path ?? normalize(cwd),
      // Stale roots are reported, never offered: they are not writable.
      dirs: project.dirs ?? [],
    }
    rootsBySession.set(sessionId, roots)
    return roots
  }

  /** The project's own roots, main first — the entry points core never reaches. */
  const rootRows = (roots: ProjectRoots, fragment: string): ProjectCandidate[] => {
    const labeled: Array<{ root: string; label: string }> = [
      { root: roots.main, label: rootLabel(roots.main, roots) },
      ...roots.dirs.map(dir => ({ root: dir, label: basename(dir) })),
    ]
    const rows: ProjectCandidate[] = []
    for (const row of labeled) {
      if (fragment !== '' && !row.label.toLowerCase().includes(fragment.toLowerCase())) continue
      const path = normalize(row.root)
      const mention = formatProjectMention(path, true)
      if (mention === undefined) continue
      rows.push({
        name: `${row.label}/`,
        icon: 'folder' as const,
        section: '项目文件夹',
        value: encodeValue({ kind: 'dir' as const, path, mention }),
        drill: true,
      })
    }
    return rows.slice(0, MAX_CANDIDATES)
  }

  /** The location shown under a row: its parent, relative to the containing root. */
  function rowLocation(root: string, path: string): string {
    const relative = relativePath(root, path)
    const slash = relative.lastIndexOf('/')
    return slash < 0 ? '' : relative.slice(0, slash)
  }

  /** One directory level, ranked and capped. */
  const levelRows = async (
    roots: ProjectRoots,
    directory: string,
    fragment: string,
  ): Promise<ProjectCandidate[]> => {
    if (rootFor(roots, directory) === undefined) return []
    let entries
    try {
      entries = (await refDeps.api.listDir(roots.cwd, directory)).entries
    } catch {
      return []
    }
    return entries
      .filter(entry => !entry.hidden)
      .map(entry => ({ entry, score: score(entry.name, fragment) }))
      .filter((row): row is { entry: typeof row.entry; score: number } => row.score !== undefined)
      .sort((left, right) => compareRows(
        { name: left.entry.name, isDir: left.entry.isDir, score: left.score },
        { name: right.entry.name, isDir: right.entry.isDir, score: right.score },
      ))
      .slice(0, MAX_CANDIDATES)
      .flatMap((row) => {
        const path = normalize(row.entry.path)
        const mention = formatProjectMention(path, row.entry.isDir)
        if (mention === undefined) return []
        const containing = rootFor(roots, path)
        const location = rowLocation(normalize(containing ?? roots.main), path)
        return [{
          name: row.entry.isDir ? `${row.entry.name}/` : row.entry.name,
          ...(location === '' ? {} : { description: location }),
          icon: row.entry.isDir ? 'folder' as const : 'file' as const,
          section: '项目文件夹',
          value: encodeValue({ kind: row.entry.isDir ? 'dir' as const : 'file' as const, path, mention }),
          ...(row.entry.isDir ? { drill: true } : {}),
        }]
      })
  }

  return {
    trigger: '@',
    name: FILE_REF_SOURCE,
    order: 10,
    async candidates(
      session: { sessionId: string },
      req: { query: string; quoted?: boolean; signal: AbortSignal },
    ): Promise<readonly ProjectCandidate[]> {
      const roots = await rootsFor(session.sessionId)
      if (roots === undefined || req.signal.aborted) return []
      const { directory, fragment } = splitQuery(req.query)
      if (directory === '') return rootRows(roots, fragment)
      const resolved = resolveQueryDirectory(roots, directory)
      if (resolved === undefined) return []
      return levelRows(roots, resolved, fragment)
    },
    header(session: { sessionId: string }, req: { query: string; quoted?: boolean; drilled: boolean }) {
      const cached = rootsBySession.get(session.sessionId)
      if (cached === undefined) return undefined
      return crumbsFor(cached, req.query, req.quoted === true, req.drilled)
    },
    onPick(pick: { candidate: { value?: string }; action: 'pick' | 'drill' }) {
      const value = decodeValue(pick.candidate.value)
      if (value === undefined) return undefined
      // A directory row carries two verbs: the drill keeps the descent text
      // and the open menu, while the settling pick resolves the folder itself
      // as an atomic reference.
      if (value.kind === 'dir' && pick.action === 'drill') {
        return { text: value.mention, continue: true }
      }
      const isDirectory = value.kind === 'dir'
      return {
        insert: {
          source: FILE_REF_SOURCE,
          // The trailing slash is the harness's directory marker: the model
          // reads a referenced directory as something to list, not to read.
          ref: isDirectory ? `${value.path}${DIRECTORY_SUFFIX}` : value.path,
          label: isDirectory ? `${basename(value.path)}/` : basename(value.path),
          appearance: isDirectory ? 'folder' : 'file',
          clipboardText: value.path,
        },
      }
    },
    codec: {
      // The copy / persistence projection of one chip.
      clipboardText: (ref: string) => ref,
      // The model-visible form: the absolute path as inline code (the harness's
      // recognized file-tool path), so it lands in context as a real reference.
      serialize: (ref: string) => Promise.resolve(`\`${ref}\``),
    },
  }
}

/**
 * Inject one file/directory reference chip into the session composer draft.
 * The chip is appended at the current draft end; its label is the name and its
 * absolute path travels as `ref`. Directories keep the trailing slash the
 * harness prompt reads as "list it when its contents matter". Degrades to a
 * logged no-op when the conversation service, session scope, or input shell is
 * unavailable.
 * @param ctx - the client runtime context.
 * @param scope - the target session.
 * @param path - absolute path of the referenced file or directory.
 * @param options - `isDirectory` marks a directory reference.
 */
export function insertFileReference(
  ctx: ClientRuntimeContext,
  scope: SidebarTabScope,
  path: string,
  options: { isDirectory?: boolean } = {},
): void {
  try {
    const actx = ctx.sessions?.scope(scope.sessionId)
    if (actx === undefined) return
    const conversation = ctx.get?.('conversation') as DraftInput | undefined
    if (conversation === undefined) return
    const input = conversation.input?.for(actx)
    if (input === undefined) return
    const state = input.state.getSnapshot()
    const span: FileReferenceSpan = {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev,
    }
    const isDirectory = options.isDirectory === true
    const reference: FileReferenceInsert = {
      source: FILE_REF_SOURCE,
      ref: isDirectory ? `${normalize(path)}${DIRECTORY_SUFFIX}` : path,
      label: isDirectory ? `${basename(path)}/` : basename(path),
      ...(isDirectory ? { appearance: 'folder' } : { appearance: 'file' }),
      clipboardText: path,
    }
    const sessionCtx = actx as { emit(event: string, payload: unknown): unknown }
    sessionCtx.emit(INSERT_REFERENCE_EVENT, { reference, span })
  } catch (error) {
    console.warn('[dsh-codex-project] file reference insert failed:', error)
  }
}
