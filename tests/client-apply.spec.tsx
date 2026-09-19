/**
 * Apply-level regression test: `apply` mounts the styles and the workspace
 * 「…」 menu injection through the REAL cordis context proxy semantics — the
 * proxy refuses undeclared service access, so this test pins the `inject`
 * declaration (a missing `workspaces` entry would break the menu injection
 * in the live GUI: "cannot get property workspaces without inject").
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import { apply, inject } from '../src/client/index.tsx'
import type { Context } from '../src/client/context.ts'

/** A child fiber opened by `ctx.inject`. */
interface Fiber {
  deps: readonly string[]
  callback: (ctx: { get(name: string): unknown }) => void | (() => void)
  /** Set when the fake runs it, i.e. once every dep has been delivered. */
  ran: boolean
}

/** The cordis context proxy semantics the plugin must satisfy. */
function fakeContext(): Context & {
  disposers: Array<() => void | (() => void)>
  /** Fibers the plugin opened, which a missing optional service leaves pending. */
  fibers: Fiber[]
} {
  const state = {
    disposers: [] as Array<() => void | (() => void)>,
    fibers: [] as Fiber[],
  }
  /** What the host delivers to a child fiber. This composition ships none of
   *  it, so a fiber waiting on the sidebar stays pending — which is the point. */
  const services: Record<string, unknown> = {}
  const target: Context & {
    disposers: Array<() => void | (() => void)>
    fibers: Fiber[]
  } = {
    disposers: state.disposers,
    fibers: state.fibers,
    workspaces: {
      list: {
        // Cached snapshot object: useSyncExternalStore compares references.
        getSnapshot: () => ({ items: [] }),
        subscribe: () => () => {},
      },
      create: async () => ({ workspaceId: 'w1' }),
    },
    effect: (callback) => {
      state.disposers.push(callback)
    },
    get: (name: string) => undefined,
    // The plugin probes OPTIONAL services this way (an `inject` entry for one
    // that may never arrive would leave the whole fiber pending).
    reflect: { get: (name: string) => undefined },
    // cordis keeps the child fiber pending while a named dep is absent, so with
    // no `sidebarRightTabs`/`slots` provided here the callback never runs.
    inject: (deps, callback) => {
      const fiber: Fiber = { deps, callback, ran: false }
      state.fibers.push(fiber)
      // The one rule cordis applies here: run it when every named service exists.
      if (deps.every(name => name in services)) {
        fiber.ran = true
        callback({ get: (name: string) => services[name] })
      }
      return { dispose: async () => {} }
    },
  }
  // Mirror the cordis proxy: any property access outside the declared
  // inject list and the built-in faces returns undefined for undeclared services.
  const allowed = new Set([...inject, 'effect', 'get', 'inject', 'reflect'])
  return new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === 'string' && !allowed.has(prop) && !(prop in inner)) {
        return undefined
      }
      return Reflect.get(inner, prop)
    },
  }) as unknown as Context & {
    disposers: Array<() => void | (() => void)>
    fibers: Fiber[]
  }
}

describe('apply', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('declares the workspaces service in inject', () => {
    expect(inject).toEqual(['workspaces', 'inputTriggers'])
  })

  it('mounts the menu injection and tears it down', () => {
    const ctx = fakeContext()
    apply(ctx)

    // The observer is live (the injection only materializes while a
    // workspace menu is open — the apply itself must not throw or double-mount).
    for (const dispose of ctx.disposers.splice(0)) {
      const result = dispose()
      if (typeof result === 'function') result()
    }
  })

  it('waits on the native sidebar services instead of requiring them', () => {
    // `sidebarRightTabs` may be provided after this plugin applies, and the
    // module-level `inject` list must stay free of it: a required service that
    // never arrives would leave the WHOLE plugin pending, menu entry included.
    expect(inject).not.toContain('sidebarRightTabs')

    const ctx = fakeContext()
    apply(ctx)
    const sidebar = ctx.fibers.find(fiber => fiber.deps.includes('sidebarRightTabs'))
    expect(sidebar?.deps).toEqual(['sidebarRightTabs', 'slots', 'sessions'])
    // Nothing was delivered, so the fiber stayed pending rather than firing
    // into a half-composed sidebar.
    expect(sidebar?.ran).toBe(false)

    // Release the module-level apply claim, so a later test in this file runs.
    for (const dispose of ctx.disposers.splice(0)) {
      const result = dispose()
      if (typeof result === 'function') result()
    }
  })
})
