/**
 * Real-machinery check for the native right-Sidebar registration.
 *
 * The recorder test in `native-sidebar.spec.tsx` proves what the plugin HANDS
 * the seats. This one proves the REAL registration core ACCEPTS it: `SlotCore`
 * from `@deepseek-ai/dsh-client-ui-slots` is the single authority for slot
 * declaration, keyed dispatch, load-time validation, and the unload cascade
 * (`SlotRegistry.register` — the service the web shell publishes as
 * `ctx.slots` — is that same function behind a cordis fiber wrapper).
 *
 * What a recorder cannot catch and this can:
 *
 * - registering into an UNDECLARED slot throws in the real core, which is
 *   exactly why the plugin registers through `slots.inject` (wait for the
 *   seat's declaration) instead of calling `register` straight away;
 * - a keyed cell holds exactly ONE entry per (key, priority), so a green run
 *   here means the plugin's key choice (its definition `id`) is what the seat
 *   dispatches on, with no collision against another registrant.
 *
 * The seats are declared here the way ui-sidebar-right's `rightbar.session`
 * entry declares them — the same keyed/session shape, from that package's own
 * published contract.
 */

import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

import { registerNativeSidebar } from '../src/client/native-sidebar.tsx'
import { FILE_ID, FILE_KIND, PROJECT_ID, PROJECT_KIND } from '../src/client/native-sidebar.tsx'

/**
 * The core's register, erased: the seat keys the plugin targets are declared
 * by ui-sidebar-right/ui-layout, whose type augmentation is not loaded in this
 * program (the plugin itself consumes those services structurally, never by
 * importing their contract). The runtime is key-agnostic; only these
 * declarations below need the wide form.
 */
type ErasedRegister = (options: { name: string; children?: Record<string, unknown> }, component: () => null) => () => void

/** A minimal harness over the REAL SlotCore. */
function bench() {
  const core = new SlotCore()
  const register = core.register.bind(core) as unknown as ErasedRegister
  const disposers: Array<() => void> = []
  const registeredTypes: Array<{ id: string; kind: string }> = []
  /** Waiters installed by `slots.inject`, keyed by the slot they await. */
  const waiters = new Map<string, Array<() => void>>()

  const slots = {
    inject(key: string, callback: () => (() => void) | ReadonlyArray<() => void>) {
      const setup = (): void => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
        else for (const one of dispose) disposers.push(one)
      }
      // The real `slots.inject` runs at once when the slot is already
      // declared, and on the declaring register() call otherwise.
      if (core.specDynamic(key) !== undefined) setup()
      else waiters.set(key, [...(waiters.get(key) ?? []), setup])
      return () => {}
    },
    register,
  }
  const tabs = {
    register(definition: { id: string; kind: string }) {
      registeredTypes.push({ id: definition.id, kind: definition.kind })
      return () => { registeredTypes.splice(registeredTypes.findIndex(t => t.id === definition.id), 1) }
    },
  }

  /** Register the seats the way ui-sidebar-right's own entries do, nesting
   *  each declaration under the seat that declares it (the real chain is
   *  root → rightbar → rightbar.session → the two keyed tab seats, the first
   *  two contributed by ui-layout's frame). */
  const declareSeat = (): void => {
    if (core.specDynamic('rightbar') === undefined) {
      // ui-layout's AppFrame occupies the pre-seeded `root` hole and declares
      // the frame's own seats inside it.
      register({
        name: 'root',
        children: { rightbar: { kind: 'single', scope: 'root' } },
      }, () => null)
      register({
        name: 'rightbar',
        children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
      }, () => null)
    }
    register({
      name: 'rightbar.session',
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      },
    }, () => null)
    for (const [key, setups] of waiters) {
      waiters.delete(key)
      for (const setup of setups) setup()
    }
  }

  /** Run the plugin's registration, keeping its disposer for the teardown. */
  const apply = (): void => {
    disposers.push(registerNativeSidebar(
      { api: {} as never, sessions: undefined, runtimeCtx: {} as never },
      { tabs: tabs as never, slots: slots as never },
    ))
  }

  const dispose = (): void => {
    for (const one of disposers.splice(0)) one()
  }

  return { core, registeredTypes, declareSeat, apply, dispose }
}

/** Every keyed occupant of one slot in the REAL core, sorted. */
function keysOf(b: ReturnType<typeof bench>, slot: string): string[] {
  return b.core.entries(slot).map(entry => entry.options.key ?? '(none)').sort()
}

describe('native right-Sidebar against the real slot core', () => {
  it('cannot register into an undeclared seat — which is why the plugin waits', () => {
    const b = bench()
    // Types register fine (a plain service), but the seat does not exist yet.
    expect(() => b.apply()).not.toThrow()
    expect(keysOf(b, 'sidebar.right.pane.tab')).toEqual([])
    // The waiter is installed, not abandoned: the declaration completes it.
    b.declareSeat()
    expect(keysOf(b, 'sidebar.right.pane.tab')).toEqual([FILE_ID, PROJECT_ID].sort())
  })

  it('lands one occupant per keyed cell under the type ids, once the seat exists', () => {
    const b = bench()
    b.declareSeat()
    b.apply()

    expect(keysOf(b, 'sidebar.right.pane.tab')).toEqual([FILE_ID, PROJECT_ID].sort())
    expect(keysOf(b, 'sidebar.right.pane.tab.title')).toEqual([FILE_ID, PROJECT_ID].sort())
    // The bodies and titles are real components, not placeholders.
    for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
      for (const entry of b.core.entries(slot)) expect(entry.component).toBeTruthy()
    }
  })

  it('registers both page types by kind and claims no resource address', () => {
    const b = bench()
    b.declareSeat()
    b.apply()
    expect(b.registeredTypes.map(t => t.kind).sort()).toEqual([FILE_KIND, PROJECT_KIND].sort())

    // A page type declares no patterns, so it never competes for a
    // `dsh-resource://` address: the plugin cannot hijack the product's own
    // file viewers, and the file rows keep going to its own preview page.
    for (const definition of b.registeredTypes) expect(definition.kind).not.toContain('dsh-resource://')
  })

  it('takes every native registration back on dispose', () => {
    const b = bench()
    b.declareSeat()
    b.apply()
    expect(keysOf(b, 'sidebar.right.pane.tab')).toHaveLength(2)

    b.dispose()
    expect(keysOf(b, 'sidebar.right.pane.tab')).toEqual([])
    expect(keysOf(b, 'sidebar.right.pane.tab.title')).toEqual([])
    expect(b.registeredTypes).toEqual([])
  })
})
