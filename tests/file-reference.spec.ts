/**
 * The project `@` reference source: how one query becomes one directory level,
 * how a drill descends into a directory (and back out through breadcrumbs),
 * and what a settled pick puts in the composer and the model context.
 *
 * The behaviours under test are the ones core discovery cannot provide: core
 * `@files` is rooted at the session cwd alone, so shared additional dirs — and
 * any descent through them — live here.
 */

import { describe, expect, it } from 'vitest'

import type { ProjectEntry, ProjectListing, ProjectView, WorkspaceDirs } from '../src/client/api.ts'
import type { ClientRuntimeContext, SidebarTabScope } from '../src/client/context.ts'
import type {
  ProjectCandidate,
  ProjectCrumb,
  ProjectReferenceValue,
  ProjectRoots,
} from '../src/client/file-reference.ts'
import {
  createFileReferenceSource,
  crumbsFor,
  decodeValue,
  FILE_REF_SOURCE,
  formatProjectMention,
  insertFileReference,
  resolveQueryDirectory,
  splitQuery,
} from '../src/client/file-reference.ts'

const CWD = 'E:/project/main'
const SHARED = 'D:/shared/lib'

/** The shape the pipeline hands the source on every hit. */
function request(query: string, overrides: { quoted?: boolean; drilled?: boolean } = {}) {
  return {
    query,
    position: 'inline' as const,
    drilled: overrides.drilled ?? false,
    ...(overrides.quoted === undefined ? {} : { quoted: overrides.quoted }),
    signal: new AbortController().signal,
  }
}

function entry(name: string, path: string, isDir: boolean, hidden = false): ProjectEntry {
  return { name, path, isDir, hidden, isSymlink: false, broken: false }
}

/** A fake project: one main root, one cross-drive shared dir, one stale root. */
function projectApi(overrides: {
  project?: ProjectView | null
  levels?: Record<string, ProjectEntry[]>
  spaces?: Record<string, WorkspaceDirs>
  fail?: boolean
} = {}) {
  const levels = overrides.levels ?? {}
  const listed: Array<{ cwd: string; path: string }> = []
  const spaces = overrides.spaces ?? { w1: { path: CWD, dirs: [SHARED] } }
  return {
    listed,
    api: {
      list: async () => {
        if (overrides.fail === true) throw new Error('network down')
        return spaces
      },
      project: async () => {
        if (overrides.fail === true) throw new Error('network down')
        return overrides.project === undefined
          ? { workspaceId: 'w1', path: CWD, dirs: [SHARED], missingDirs: ['F:/gone'] }
          : overrides.project
      },
      listDir: async (cwd: string, path: string): Promise<ProjectListing> => {
        listed.push({ cwd, path })
        if (overrides.fail === true) throw new Error('network down')
        return { path, entries: levels[path] ?? [], truncated: false }
      },
    },
  }
}

function source(overrides: Parameters<typeof projectApi>[0] = {}, cwd: string | undefined = CWD) {
  const fake = projectApi(overrides)
  const built = createFileReferenceSource(fake.api as never, { cwdFor: () => cwd }) as {
    trigger: string
    name: string
    order: number
    candidates(session: { sessionId: string }, req: ReturnType<typeof request>): Promise<readonly ProjectCandidate[]>
    header(session: { sessionId: string }, req: { query: string; quoted?: boolean; drilled: boolean }): readonly ProjectCrumb[] | undefined
    onPick(pick: { candidate: { value?: string }; action: 'pick' | 'drill' }): unknown
    codec: { clipboardText(ref: string): string; serialize(ref: string): Promise<string> }
  }
  return { ...built, listed: fake.listed }
}

const SESSION = { sessionId: 's1' }

describe('project @ source registration', () => {
  it('registers under the @ trigger under the plugin source name', () => {
    const built = source()
    expect(built.trigger).toBe('@')
    expect(built.name).toBe(FILE_REF_SOURCE)
  })

  it('serializes the absolute path as inline code for the model context', async () => {
    const built = source()
    expect(await built.codec.serialize('E:\\proj\\readme.md')).toBe('`E:\\proj\\readme.md`')
    expect(built.codec.clipboardText('E:\\proj\\readme.md')).toBe('E:\\proj\\readme.md')
  })

  it('offers nothing while the session cwd is cold and no workspaces exist', async () => {
    const built = source({ spaces: {} }, '')
    await expect(built.candidates(SESSION, request(''))).resolves.toEqual([])
    expect(built.header(SESSION, { query: `${CWD}/src/`, drilled: true })).toBeUndefined()
  })

  it('offers nothing when the project read fails', async () => {
    const built = source({ fail: true })
    await expect(built.candidates(SESSION, request(''))).resolves.toEqual([])
  })
})

describe('candidates: the project roots', () => {
  it('lists the main root and every shared dir as drillable directory rows', async () => {
    const built = source()
    const rows = await built.candidates(SESSION, request(''))
    expect(rows.map(row => row.name)).toEqual([`${CWD.split('/').pop()} (主)/`, `${SHARED.split('/').pop()}/`])
    expect(rows.every(row => row.icon === 'folder' && row.drill === true)).toBe(true)
    expect(rows.every(row => row.section === '项目文件夹')).toBe(true)
  })

  it('never offers a stale (missing) root', async () => {
    const built = source()
    const rows = await built.candidates(SESSION, request(''))
    expect(rows.some(row => row.name.includes('gone'))).toBe(false)
  })

  it('filters the roots by the typed fragment', async () => {
    const built = source()
    const rows = await built.candidates(SESSION, request('lib'))
    expect(rows.map(row => row.name)).toEqual(['lib/'])
  })

  it('offers nothing when no record anchors the session cwd', async () => {
    const built = source({ project: null })
    await expect(built.candidates(SESSION, request(''))).resolves.toEqual([])
    expect(built.header(SESSION, { query: `${CWD}/src/`, drilled: true })).toBeUndefined()
  })

  it('contributes nothing when the session cwd is cold (no sessions projection)', async () => {
    // A cold projection reports an empty cwd, so the source cannot resolve the
    // session's project — it never guesses a flat listing of foreign dirs.
    const built = source({}, '')
    await expect(built.candidates(SESSION, request(''))).resolves.toEqual([])
  })
})

describe('candidates: one directory level at a time', () => {
  const levels = {
    [CWD]: [entry('src', `${CWD}/src`, true), entry('readme.md', `${CWD}/readme.md`, false)],
    [`${CWD}/src`]: [entry('lib', `${CWD}/src/lib`, true), entry('index.ts', `${CWD}/src/index.ts`, false)],
    [SHARED]: [entry('notes.md', `${SHARED}/notes.md`, false)],
  }

  it('lists the directory a trailing-slash query names', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/`))
    expect(rows.map(row => row.name)).toEqual(['src/', 'readme.md'])
    expect(rows[0]!.drill).toBe(true)
    expect(rows[1]!.drill).toBeUndefined()
    expect(rows[1]!.icon).toBe('file')
  })

  it('reaches a shared dir on another drive — the gap core discovery leaves', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${SHARED}/`))
    expect(rows.map(row => row.name)).toEqual(['notes.md'])
    expect(rows[0]!.description).toBeUndefined()
  })

  it('descends another level from an absolute query', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/src/`))
    expect(rows.map(row => row.name)).toEqual(['lib/', 'index.ts'])
    expect(rows[1]!.description).toBe('src')
  })

  it('resolves a hand-typed relative query under the main root', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request('src/'))
    expect(rows.map(row => row.name)).toEqual(['lib/', 'index.ts'])
    expect(built.listed).toContainEqual({ cwd: CWD, path: `${CWD}/src` })
  })

  it('accepts Windows backslashes in the query', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request('E:\\project\\main\\src\\'))
    expect(rows.map(row => row.name)).toEqual(['lib/', 'index.ts'])
  })

  it('filters a level by the fragment after the last separator', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/re`))
    expect(rows.map(row => row.name)).toEqual(['readme.md'])
  })

  it('drops a fragment no entry matches', async () => {
    const built = source({ levels })
    await expect(built.candidates(SESSION, request(`${CWD}/zzz`))).resolves.toEqual([])
  })

  it('offers nothing for a path outside the project roots', async () => {
    const built = source({ levels })
    await expect(built.candidates(SESSION, request('F:/elsewhere/'))).resolves.toEqual([])
  })

  it('hides dot entries (the host marks them hidden)', async () => {
    const built = source({
      levels: { [CWD]: [entry('.cache', `${CWD}/.cache`, true, true), entry('src', `${CWD}/src`, true)] },
    })
    const rows = await built.candidates(SESSION, request(`${CWD}/`))
    expect(rows.map(row => row.name)).toEqual(['src/'])
  })

  it('offers nothing when the level cannot be read', async () => {
    const built = source({ fail: true })
    await expect(built.candidates(SESSION, request(`${CWD}/`))).resolves.toEqual([])
  })
})

describe('descent: drill keeps the menu open one level deeper', () => {
  const levels = {
    [CWD]: [entry('src', `${CWD}/src`, true), entry('readme.md', `${CWD}/readme.md`, false)],
    [`${CWD}/src`]: [entry('lib', `${CWD}/src/lib`, true), entry('index.ts', `${CWD}/src/index.ts`, false)],
  }

  it('writes the directory mention back and keeps the menu open', async () => {
    const built = source({ levels })
    const [row] = await built.candidates(SESSION, request(`${CWD}/`))
    const pick = built.onPick({ candidate: row!, action: 'drill' })
    expect(pick).toEqual({ text: `@${CWD}/src/`, continue: true })
  })

  it('re-queries the drilled text into the next level', async () => {
    const built = source({ levels })
    const [row] = await built.candidates(SESSION, request(`${CWD}/`))
    const pick = built.onPick({ candidate: row!, action: 'drill' }) as { text: string }
    // The pipeline strips the trigger and re-queries with the rest.
    const rows = await built.candidates(SESSION, request(pick.text.slice(1)))
    expect(rows.map(row => row.name)).toEqual(['lib/', 'index.ts'])
  })

  it('quotes a drilled path that contains spaces', () => {
    expect(formatProjectMention('E:/my dir/src', true)).toBe('@"E:/my dir/src/')
    expect(formatProjectMention('E:/my dir/src', false)).toBe('@"E:/my dir/src"')
    expect(formatProjectMention('E:/src', true)).toBe('@E:/src/')
  })

  it('refuses a path the trigger grammar cannot write back', () => {
    expect(formatProjectMention('E:/src\0', true)).toBeUndefined()
  })

  it('drills into a shared dir the same way', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(''))
    const shared = rows.find(row => decodeValue(row.value)?.path === SHARED)!
    expect(built.onPick({ candidate: shared, action: 'drill' })).toEqual({
      text: `@${SHARED}/`,
      continue: true,
    })
  })
})

describe('descent: breadcrumbs lead back out', () => {
  const roots: ProjectRoots = { cwd: CWD, main: CWD, dirs: [SHARED] }

  it('publishes no header until a drill produced the query', () => {
    expect(crumbsFor(roots, `${CWD}/src/`, false, false)).toBeUndefined()
  })

  it('publishes one crumb per segment, from the containing root down', () => {
    const crumbs = crumbsFor(roots, `${CWD}/src/lib/`, false, true)
    expect(crumbs?.map(crumb => crumb.label)).toEqual(['main (主)', 'src', 'lib'])
    expect(crumbs?.at(-1)?.current).toBe(true)
    expect(crumbs?.map(crumb => decodeValue(crumb.value)?.path)).toEqual([CWD, `${CWD}/src`, `${CWD}/src/lib`])
  })

  it('anchors a shared-dir listing at that dir', () => {
    const crumbs = crumbsFor(roots, `${SHARED}/notes/`, false, true)
    expect(crumbs?.map(crumb => crumb.label)).toEqual(['lib', 'notes'])
  })

  it('routes a crumb back through the same drill path a folder row uses', async () => {
    const built = source()
    await built.candidates(SESSION, request(''))
    const crumbs = built.header(SESSION, { query: `${CWD}/src/lib/`, drilled: true })
    const step = crumbs![1]!
    expect(built.onPick({ candidate: { value: step.value }, action: 'drill' })).toEqual({
      text: `@${CWD}/src/`,
      continue: true,
    })
  })

  it('publishes no header for a path outside the project', () => {
    expect(crumbsFor(roots, 'F:/elsewhere/', false, true)).toBeUndefined()
  })
})

describe('settling picks: files reach the composer and the model context', () => {
  const levels = {
    [CWD]: [entry('src', `${CWD}/src`, true), entry('readme.md', `${CWD}/readme.md`, false)],
    [SHARED]: [entry('notes.md', `${SHARED}/notes.md`, false)],
  }

  it('inserts a file chip whose ref is the absolute path', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/`))
    const file = rows.find(row => row.name === 'readme.md')!
    expect(built.onPick({ candidate: file, action: 'pick' })).toEqual({
      insert: {
        source: FILE_REF_SOURCE,
        ref: `${CWD}/readme.md`,
        label: 'readme.md',
        appearance: 'file',
        clipboardText: `${CWD}/readme.md`,
      },
    })
  })

  it('settles a shared-dir file into a chat chip (the reported bug)', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${SHARED}/`))
    const file = rows.find(row => row.name === 'notes.md')!
    const outcome = built.onPick({ candidate: file, action: 'pick' }) as {
      insert: { source: string; ref: string; label: string; clipboardText: string }
    }
    expect(outcome.insert.source).toBe(FILE_REF_SOURCE)
    expect(outcome.insert.ref).toBe(`${SHARED}/notes.md`)
    expect(outcome.insert.label).toBe('notes.md')
    // The chip serializes the absolute path into the model context.
    await expect(built.codec.serialize(outcome.insert.ref)).resolves.toBe(`\`${SHARED}/notes.md\``)
  })

  it('marks a directory chip so the model knows to list it, not read it', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/`))
    const dir = rows.find(row => row.name === 'src/')!
    const outcome = built.onPick({ candidate: dir, action: 'pick' }) as {
      insert: { ref: string; label: string; appearance: string }
    }
    expect(outcome.insert.ref).toBe(`${CWD}/src/`)
    expect(outcome.insert.label).toBe('src/')
    expect(outcome.insert.appearance).toBe('folder')
  })

  it('serializes a directory chip with the trailing slash the harness prompt reads', async () => {
    const built = source({ levels })
    const rows = await built.candidates(SESSION, request(`${CWD}/`))
    const dir = rows.find(row => row.name === 'src/')!
    const outcome = built.onPick({ candidate: dir, action: 'pick' }) as { insert: { ref: string } }
    await expect(built.codec.serialize(outcome.insert.ref)).resolves.toBe(`\`${CWD}/src/\``)
  })

  it('ignores a pick this source did not produce', () => {
    const built = source()
    expect(built.onPick({ candidate: { value: 'not-json' }, action: 'pick' })).toBeUndefined()
    expect(built.onPick({ candidate: {}, action: 'pick' })).toBeUndefined()
  })
})

describe('query splitting (the descent protocol)', () => {
  it('splits a query at its last separator', () => {
    expect(splitQuery('src/lib/in')).toEqual({ directory: 'src/lib/', fragment: 'in' })
    expect(splitQuery('src/lib/')).toEqual({ directory: 'src/lib/', fragment: '' })
    expect(splitQuery('rea')).toEqual({ directory: '', fragment: 'rea' })
    expect(splitQuery('')).toEqual({ directory: '', fragment: '' })
  })

  it('normalizes Windows separators', () => {
    expect(splitQuery('src\\lib\\in')).toEqual({ directory: 'src/lib/', fragment: 'in' })
  })

  it('resolves an empty query as the main root', () => {
    const roots: ProjectRoots = { cwd: CWD, main: CWD, dirs: [SHARED] }
    expect(resolveQueryDirectory(roots, '')).toBe(CWD)
  })

  it('rejects a relative query that climbs out of the project', () => {
    const roots: ProjectRoots = { cwd: CWD, main: CWD, dirs: [SHARED] }
    expect(resolveQueryDirectory(roots, '../elsewhere/')).toBeUndefined()
  })
})

describe('decodeValue', () => {
  it('round-trips one row payload', () => {
    const value: ProjectReferenceValue = { kind: 'dir', path: CWD, mention: `@${CWD}/` }
    expect(decodeValue(JSON.stringify(value))).toEqual(value)
  })

  it('rejects payloads this source did not produce', () => {
    expect(decodeValue(undefined)).toBeUndefined()
    expect(decodeValue('{oops')).toBeUndefined()
    expect(decodeValue(JSON.stringify({ kind: 'session' }))).toBeUndefined()
    expect(decodeValue(JSON.stringify({ kind: 'dir' }))).toBeUndefined()
  })
})

describe('insertFileReference', () => {
  const scope: SidebarTabScope = { sessionId: 's1', cwd: 'E:\\proj' }

  function harness() {
    const chips: Array<{ reference: Record<string, unknown>; span: unknown }> = []
    const ctx: ClientRuntimeContext = {
      get: () => ({ input: { for: () => ({ state: { getSnapshot: () => ({ draft: '', draftRev: 3 }) } }) } }),
      sessions: { scope: () => ({ emit: (_event: string, payload: unknown) => { chips.push(payload as never) } }) },
    }
    return { chips, ctx }
  }

  it('dispatches a file chip with the absolute path and the file-name label', () => {
    const { chips, ctx } = harness()
    insertFileReference(ctx, scope, 'E:\\proj\\readme.md')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.reference.source).toBe(FILE_REF_SOURCE)
    expect(chips[0]!.reference.ref).toBe('E:\\proj\\readme.md')
    expect(chips[0]!.reference.label).toBe('readme.md')
    expect(chips[0]!.reference.appearance).toBe('file')
    expect(chips[0]!.span).toEqual({ start: 0, end: 0, draftRev: 3 })
  })

  it('marks a directory chip with the trailing slash and folder appearance', () => {
    const { chips, ctx } = harness()
    insertFileReference(ctx, scope, 'E:\\proj\\src', { isDirectory: true })
    expect(chips[0]!.reference.ref).toBe('E:/proj/src/')
    expect(chips[0]!.reference.label).toBe('src/')
    expect(chips[0]!.reference.appearance).toBe('folder')
  })

  it('no-ops when the conversation service is missing', () => {
    let emitted = false
    const ctx: ClientRuntimeContext = {
      get: () => undefined,
      sessions: { scope: () => ({ emit: () => { emitted = true } }) },
    }
    insertFileReference(ctx, scope, 'E:\\proj\\readme.md')
    expect(emitted).toBe(false)
  })
})
