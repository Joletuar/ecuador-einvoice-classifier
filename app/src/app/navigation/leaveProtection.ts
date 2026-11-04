import { shallowRef, type InjectionKey } from 'vue'

export interface LeavePolicy {
  isBlocked(): boolean
  isUpdateBlocked?(): boolean
  isDirty(): boolean
  confirmDiscard(): Promise<boolean>
  commitLeave(): void
  cancelLeave?(): void
}

interface LeaveDecision {
  allowed: boolean
  commit(): void
  cancel(): void
}

const blockedDecision: LeaveDecision = {
  allowed: false,

  commit() {},

  cancel() {},
}

export function createLeaveProtection() {
  const active = shallowRef<LeavePolicy | null>(null)
  const globalBlockers = new Set<() => boolean>()
  const navigationBlockers = new Set<() => boolean>()
  let approved: {
    id: number
    policy: LeavePolicy
  } | null = null
  let confirming = false
  let nextDecision = 0

  function register(policy: LeavePolicy) {
    active.value = policy

    return () => {
      if (active.value === policy) {
        active.value = null
      }

      if (approved?.policy === policy) {
        approved = null
      }
    }
  }

  function registerGlobalBlocker(isBlocked: () => boolean) {
    globalBlockers.add(isBlocked)

    return () => {
      globalBlockers.delete(isBlocked)
    }
  }

  function isGloballyBlocked() {
    return [...globalBlockers].some((isBlocked) => isBlocked())
  }

  async function prepareLeave(): Promise<LeaveDecision> {
    const policy = active.value

    if (
      confirming ||
      [...navigationBlockers].some((blocked) => blocked()) ||
      isGloballyBlocked() ||
      policy?.isBlocked()
    ) {
      return blockedDecision
    }

    if (!policy) {
      return { allowed: true, commit() {}, cancel() {} }
    }

    if (policy.isDirty()) {
      confirming = true

      try {
        if (!(await policy.confirmDiscard())) {
          return blockedDecision
        }
      } catch {
        policy.cancelLeave?.()

        return blockedDecision
      } finally {
        confirming = false
      }

      if (active.value !== policy) {
        return blockedDecision
      }

      if (isGloballyBlocked()) {
        policy.cancelLeave?.()

        return blockedDecision
      }
    }

    const id = ++nextDecision

    approved = { id, policy }

    function settle(commit: boolean) {
      if (approved?.id !== id) {
        return
      }

      const decision = approved

      approved = null

      if (active.value !== decision.policy) {
        return
      }

      if (commit) {
        decision.policy.commitLeave()
      } else {
        decision.policy.cancelLeave?.()
      }
    }

    return {
      allowed: true,

      commit: () => settle(true),

      cancel: () => settle(false),
    }
  }

  return {
    register,
    registerGlobalBlocker,

    registerNavigationBlocker(isBlocked: () => boolean) {
      navigationBlockers.add(isBlocked)

      return () => {
        navigationBlockers.delete(isBlocked)
      }
    },

    prepareLeave,

    isUpdateBlocked: () =>
      confirming ||
      isGloballyBlocked() ||
      Boolean(active.value?.isUpdateBlocked?.() ?? active.value?.isBlocked()),

    isPageBlocked: () => Boolean(active.value?.isBlocked()),

    isDirty: () => Boolean(active.value?.isDirty()),
  }
}

export type LeaveProtection = ReturnType<typeof createLeaveProtection>

export const leaveProtectionKey: InjectionKey<LeaveProtection> =
  Symbol('leaveProtection')
