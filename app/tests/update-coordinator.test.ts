import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdateCoordinator } from '../src/app/updateCoordinator'
import { createTabCoordinator } from '../src/app/tabCoordination'
import { webLocks } from './fixtures/webLocks'

const cleanup: (() => void)[] = []

afterEach(async () => {
  cleanup.splice(0).forEach((dispose) => dispose())

  await Promise.resolve()

  vi.unstubAllGlobals()
})

function participant(locks = webLocks()) {
  vi.stubGlobal('navigator', { locks })
  vi.stubGlobal('BroadcastChannel', undefined)

  const writer = createTabCoordinator()
  const local = { busy: false, dirty: false }
  const updates = createUpdateCoordinator({
    writer,
    locks,

    isBlocked: () => local.busy,

    isDirty: () => local.dirty,
  })

  cleanup.push(() => {
    updates.dispose()
    writer.dispose()
  })

  return { writer, updates, local }
}

const permission = () => ({ allowed: true, commit: vi.fn(), cancel: vi.fn() })

describe('all-tab update admission', () => {
  it('keeps selection and mutations blocked until the shared lease and version check complete', async () => {
    const { updates } = participant()
    let finish!: (value: boolean) => void
    const checking = updates.admit(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    expect(updates.interaction.blocked.value).toBe(true)

    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))

    finish(true)
    expect(await checking).toBe(true)
    expect(updates.interaction.blocked.value).toBe(false)
  })

  it('does not admit an unsupported browser or a stale document', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('BroadcastChannel', undefined)

    const writer = createTabCoordinator()
    const updates = createUpdateCoordinator({
      writer,

      isBlocked: () => false,

      isDirty: () => false,
    })

    expect(await updates.admit(async () => true)).toBe(false)
    expect(updates.interaction.blocked.value).toBe(true)
    updates.dispose()
    writer.dispose()

    const tab = participant()

    expect(await tab.updates.admit(async () => false)).toBe(false)
    expect(await tab.updates.prepare('stale')).toBe(false)
  })

  it.each(['processing', 'pending commit', 'correction', 'delete', 'clear'])(
    'refuses a tab with local %s without discarding anything',
    async () => {
      const { updates, local } = participant()

      await updates.admit(async () => true)

      local.busy = true
      expect(await updates.prepare('attempt')).toBe(false)
      expect(updates.interaction.blocked.value).toBe(false)
      expect(local.busy).toBe(true)
    },
  )

  it('refuses another tab’s dirty draft and local writer, without using global busy as a veto', async () => {
    const { updates, local, writer } = participant()

    await updates.admit(async () => true)

    local.dirty = true
    expect(await updates.prepare('attempt')).toBe(false)
    expect(local.dirty).toBe(true)
    local.dirty = false

    await writer.withWriter(async () => {
      expect(await updates.prepare('attempt')).toBe(false)
    })
  })

  it('keeps the same writer reservation and commits its own authorized discard only after activation', async () => {
    const locks = webLocks()
    const first = participant(locks)
    const second = participant(locks)

    await Promise.all([
      first.updates.admit(async () => true),
      second.updates.admit(async () => true),
    ])

    first.local.dirty = true

    const consent = permission()
    const updating = first.updates.withUpdate('attempt', consent, async () => {
      expect(await first.updates.prepare('attempt')).toBe(true)
      expect(await second.updates.prepare('attempt')).toBe(true)
      expect(await first.updates.acquireExclusive('attempt')).toBe(true)

      await expect(
        second.writer.withWriter(async () => undefined),
      ).rejects.toMatchObject({ code: 'storage-busy' })

      first.updates.activationSent('attempt')
    })

    expect(first.updates.interaction.blocked.value).toBe(true)

    await vi.waitFor(() => expect(first.updates.isPrepared()).toBe(true))
    await vi.waitFor(async () =>
      expect(
        (await locks.query()).held?.some(
          (lock) =>
            lock.mode === 'exclusive' &&
            lock.name === 'facturas-locales:update',
        ),
      ).toBe(true),
    )

    expect(consent.commit).not.toHaveBeenCalled()
    expect(consent.cancel).not.toHaveBeenCalled()
    expect(await first.updates.abort('attempt')).toBe(false)
    first.updates.activated()

    await updating

    expect(consent.commit).toHaveBeenCalledOnce()
    expect(first.updates.interaction.blocked.value).toBe(true)
    expect(await first.updates.abort('attempt')).toBe(false)
  })

  it('cancels provisional permission and reacquires admission before restoring interactions', async () => {
    const { updates, local } = participant()

    await updates.admit(async () => true)

    local.dirty = true

    const consent = permission()

    await expect(
      updates.withUpdate('attempt', consent, async () => {
        expect(await updates.prepare('attempt')).toBe(true)

        throw new Error('Other tab declined')
      }),
    ).rejects.toThrow('Other tab declined')

    expect(consent.cancel).toHaveBeenCalledOnce()
    expect(consent.commit).not.toHaveBeenCalled()
    expect(updates.interaction.blocked.value).toBe(false)
    expect(local.dirty).toBe(true)
  })

  it('refuses a simultaneous updater and an update while another tab retains its processing writer', async () => {
    const locks = webLocks()
    const first = participant(locks)
    const second = participant(locks)

    await Promise.all([
      first.updates.admit(async () => true),
      second.updates.admit(async () => true),
    ])
    await first.writer.withWriter(async () => {
      const consent = permission()

      await expect(
        second.updates.withUpdate('second', consent, async () => {}),
      ).rejects.toMatchObject({ code: 'storage-busy' })

      expect(consent.cancel).toHaveBeenCalledOnce()
    })
    await first.updates.withUpdate('first', permission(), async () => {
      await expect(
        second.updates.withUpdate('second', permission(), async () => {}),
      ).rejects.toMatchObject({ code: 'storage-busy' })
      await first.updates.abort('first')
    })
  })

  it('detects a new tab between prepare and exclusive acquisition', async () => {
    const locks = webLocks()
    const first = participant(locks)

    await first.updates.admit(async () => true)
    await first.updates.withUpdate('attempt', permission(), async () => {
      expect(await first.updates.prepare('attempt')).toBe(true)

      const newcomer = participant(locks)

      await newcomer.updates.admit(async () => true)

      expect(await first.updates.acquireExclusive('attempt')).toBe(false)

      await first.updates.abort('attempt')
    })

    expect(first.updates.interaction.blocked.value).toBe(false)
  })

  it('checks a new tab’s actual controller version after a pending exclusive lease releases', async () => {
    const locks = webLocks()
    const first = participant(locks)
    const newcomer = participant(locks)

    await first.updates.admit(async () => true)

    let checkVersion = false
    const update = first.updates.withUpdate(
      'attempt',
      permission(),
      async () => {
        await first.updates.prepare('attempt')

        expect(await first.updates.acquireExclusive('attempt')).toBe(true)
        first.updates.activationSent('attempt')
      },
    )

    await vi.waitFor(async () =>
      expect(
        (await locks.query()).held?.some(
          (lock) =>
            lock.mode === 'exclusive' &&
            lock.name === 'facturas-locales:update',
        ),
      ).toBe(true),
    )

    const admission = newcomer.updates.admit(async () => {
      checkVersion = true

      return false
    })

    await Promise.resolve()

    expect(checkVersion).toBe(false)
    first.updates.dispose()

    await update

    expect(await admission).toBe(false)
    expect(checkVersion).toBe(true)
    expect(newcomer.updates.interaction.blocked.value).toBe(true)
  })

  it('ignores a different attempt, waits for native release before ACK and cancels queued admission on disposal', async () => {
    const locks = webLocks()
    const { updates } = participant(locks)

    await updates.admit(async () => true)

    expect(await updates.prepare('current')).toBe(true)
    expect((await locks.query()).held).toEqual([])
    expect(await updates.prepare('different')).toBe(false)
    expect(await updates.abort('different')).toBe(false)
    expect(await updates.abort('current')).toBe(true)
    expect(updates.interaction.blocked.value).toBe(false)

    const exclusive = locks.request(
      'facturas-locales:update',
      { mode: 'exclusive' },
      async () => {
        const pendingTab = participant(locks)
        const admission = pendingTab.updates.admit(async () => true)

        pendingTab.updates.dispose()
        expect(await admission).toBe(false)
      },
    )

    updates.dispose()

    await exclusive
  })
})
