import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTabCoordinator } from '../src/app/tabCoordination'

function locksDouble() {
  const held = new Set<string>()

  return {
    async request<T>(
      name: string,
      _options: unknown,
      work: (lock: { name: string } | null) => Promise<T>,
    ) {
      if (held.has(name)) {
        return work(null)
      }

      held.add(name)

      try {
        return await work({ name })
      } finally {
        held.delete(name)
      }
    },

    async query() {
      return { held: [...held].map((name) => ({ name })), pending: [] }
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser writer coordination', () => {
  it('truthfully rejects unsupported environments without a process-local fallback', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('BroadcastChannel', undefined)

    const coordinator = createTabCoordinator()

    expect(coordinator.supported).toBe(false)

    await expect(
      coordinator.withWriter(async () => 'unsafe'),
    ).rejects.toMatchObject({ code: 'coordination-unavailable' })

    coordinator.dispose()
  })
  it('uses the same Web Lock across coordinators while reads remain possible', async () => {
    vi.stubGlobal('navigator', { locks: locksDouble() })
    vi.stubGlobal('BroadcastChannel', undefined)

    const first = createTabCoordinator()
    const second = createTabCoordinator()

    await first.withWriter(async () => {
      expect(await second.isBusy()).toBe(true)

      await expect(
        second.withWriter(async () => undefined),
      ).rejects.toMatchObject({ code: 'storage-busy' })
    })

    expect(await second.isBusy()).toBe(false)
    expect(await second.withWriter(async () => 'ok')).toBe('ok')
    first.dispose()
    second.dispose()
  })
  it('tolerates notification construction, posting and observer failures', async () => {
    vi.stubGlobal('navigator', { locks: locksDouble() })
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('disabled')
        }
      },
    )

    const noChannel = createTabCoordinator()

    expect(await noChannel.withWriter(async () => 'written')).toBe('written')
    noChannel.dispose()
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {
          throw new Error('posting disabled')
        }
        close() {}
      },
    )

    const brokenChannel = createTabCoordinator()

    brokenChannel.subscribe(() => {
      throw new Error('observer failed')
    })
    expect(
      await brokenChannel.withWriter(async () => {
        brokenChannel.notifyChanged()

        return 'confirmed'
      }),
    ).toBe('confirmed')
    expect(await brokenChannel.isBusy()).toBe(false)
    brokenChannel.dispose()
  })
  it('releases the lock and preserves success if disposed during a writer', async () => {
    const locks = locksDouble()

    vi.stubGlobal('navigator', { locks })
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage() {}
        close() {}
      },
    )

    const coordinator = createTabCoordinator()

    expect(
      await coordinator.withWriter(async () => {
        coordinator.dispose()

        return 'confirmed'
      }),
    ).toBe('confirmed')
    expect(await coordinator.isBusy()).toBe(false)
    expect((await locks.query()).held).toEqual([])

    await expect(
      coordinator.withWriter(async () => undefined),
    ).rejects.toMatchObject({ code: 'coordination-unavailable' })
  })
  it('releases after failure and allows a later writer', async () => {
    vi.stubGlobal('navigator', { locks: locksDouble() })
    vi.stubGlobal('BroadcastChannel', undefined)

    const coordinator = createTabCoordinator()

    await expect(
      coordinator.withWriter(async () => {
        throw new Error('failed write')
      }),
    ).rejects.toThrow('failed write')

    expect(await coordinator.withWriter(async () => 'retry')).toBe('retry')
    coordinator.dispose()
  })
})
