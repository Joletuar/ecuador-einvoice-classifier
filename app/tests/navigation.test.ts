import { describe, expect, it, vi } from 'vitest'
import { computed, shallowRef } from 'vue'
import {
  createLeaveProtection,
  type LeavePolicy,
} from '../src/app/navigation/leaveProtection'

function policy(overrides: Partial<LeavePolicy> = {}): LeavePolicy {
  return {
    isBlocked: () => false,

    isDirty: () => true,

    confirmDiscard: async () => true,

    commitLeave: vi.fn(),
    cancelLeave: vi.fn(),
    ...overrides,
  }
}

describe('navigation consent', () => {
  it('keeps global blockers separate from the reactive active page policy', async () => {
    const protection = createLeaveProtection()
    const blocked = computed(() => protection.isPageBlocked())
    const dirty = computed(() => protection.isDirty())
    const pending = shallowRef(true)
    const unregisterGlobal = protection.registerGlobalBlocker(
      () => pending.value,
    )

    expect((await protection.prepareLeave()).allowed).toBe(false)
    expect(blocked.value).toBe(false)
    expect(dirty.value).toBe(false)

    const page = policy()
    const unregisterPage = protection.register(page)

    expect(dirty.value).toBe(true)
    expect(blocked.value).toBe(false)
    expect((await protection.prepareLeave()).allowed).toBe(false)
    pending.value = false

    const allowed = await protection.prepareLeave()

    expect(allowed.allowed).toBe(true)
    allowed.commit()
    expect(page.commitLeave).toHaveBeenCalledOnce()

    protection.register(policy({ isBlocked: () => true, isDirty: () => false }))
    unregisterPage()
    expect(blocked.value).toBe(true)
    expect(dirty.value).toBe(false)
    unregisterGlobal()
    expect((await protection.prepareLeave()).allowed).toBe(false)
  })

  it('rejects a pending page consent when a global operation starts', async () => {
    const protection = createLeaveProtection()
    let confirm!: (value: boolean) => void
    const page = policy({
      confirmDiscard: () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve
        }),
    })

    protection.register(page)

    const decision = protection.prepareLeave()
    const unregister = protection.registerGlobalBlocker(() => true)

    confirm(true)
    expect((await decision).allowed).toBe(false)
    expect(page.commitLeave).not.toHaveBeenCalled()
    unregister()
  })

  it('keeps consent provisional until navigation commits', async () => {
    const protection = createLeaveProtection()
    const page = policy()

    protection.register(page)

    const decision = await protection.prepareLeave()

    expect(decision.allowed).toBe(true)
    expect(page.commitLeave).not.toHaveBeenCalled()
    decision.cancel()
    expect(page.commitLeave).not.toHaveBeenCalled()
    expect(page.cancelLeave).toHaveBeenCalledOnce()

    const accepted = await protection.prepareLeave()

    accepted.commit()
    accepted.commit()
    expect(page.commitLeave).toHaveBeenCalledOnce()
  })

  it('preserves drafts on rejection and blocks busy operations', async () => {
    const protection = createLeaveProtection()
    const page = policy({ confirmDiscard: async () => false })

    protection.register(page)
    expect((await protection.prepareLeave()).allowed).toBe(false)
    expect(page.commitLeave).not.toHaveBeenCalled()

    const busy = policy({ isBlocked: () => true })

    protection.register(busy)
    expect((await protection.prepareLeave()).allowed).toBe(false)
  })

  it('does not commit an old page or a superseded decision', async () => {
    const protection = createLeaveProtection()
    const page = policy({ isDirty: () => false })

    protection.register(page)

    const first = await protection.prepareLeave()
    const second = await protection.prepareLeave()

    first.cancel()
    second.commit()
    expect(page.commitLeave).toHaveBeenCalledOnce()

    const third = await protection.prepareLeave()

    protection.register(policy())
    third.commit()
    expect(page.commitLeave).toHaveBeenCalledOnce()
  })
})
