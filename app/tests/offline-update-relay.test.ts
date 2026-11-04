import { describe, expect, it, vi } from 'vitest'
import {
  createOfflineUpdateRelay,
  type UpdateClient,
} from '../src/features/offline/services/offlineUpdateRelay'
import {
  offlineProtocol,
  offlineProtocolVersion,
  type ClientUpdateRequest,
  type UpdateRequest,
  type CandidateStateRequest,
} from '../src/features/offline/services/offlineProtocol'
import type { ReleaseControlState } from '../src/features/offline/services/releaseControl'

const identity = { appReleaseId: 'release-b', modelPackageId: 'package' }
const request = (
  type: UpdateRequest['type'],
  attemptId = 'attempt-1',
): UpdateRequest => ({
  protocol: offlineProtocol,
  version: offlineProtocolVersion,
  requestId: crypto.randomUUID(),
  expected: identity,
  type,
  attemptId,
})

function client(
  id: string,
  answer: 'ready' | 'busy' | 'silent' | 'stale' | 'old-version' = 'ready',
) {
  const messages: ClientUpdateRequest[] = []
  const value: UpdateClient = {
    id,

    postMessage(message, transfer) {
      messages.push(message)

      const port = transfer[0] as MessagePort

      if (answer === 'silent') {
        return port.close()
      }

      port.postMessage({
        protocol: offlineProtocol,
        version:
          answer === 'old-version'
            ? offlineProtocolVersion - 1
            : offlineProtocolVersion,
        type:
          message.type === 'PREPARE_CLIENT_UPDATE'
            ? 'CLIENT_UPDATE_READY'
            : 'CLIENT_UPDATE_ABORTED',
        requestId: answer === 'stale' ? 'other-request' : message.requestId,
        attemptId: message.attemptId,
        candidate: message.candidate,
        accepted: message.type === 'ABORT_CLIENT_UPDATE' || answer !== 'busy',
      })
      port.close()
    },
  }

  return { value, messages }
}

function fixture(
  answers: Parameters<typeof client>[1][] = ['ready', 'ready'],
  preparedTimeoutMs = 30_000,
) {
  const clients = answers.map((answer, index) => client(`tab-${index}`, answer))
  let scoped = clients.map((entry) => entry.value)
  const activate = vi.fn(async () => undefined)
  const ready = vi.fn(async () => true)
  let state: ReleaseControlState = { state: 'idle' }
  const control = {
    read: vi.fn(async (): Promise<ReleaseControlState> => state),
    commit: vi.fn(async (attemptId: string): Promise<ReleaseControlState> => {
      state = { state: 'activation-committed', attemptId }

      return state
    }),
  }
  const options = {
    identity,
    control,

    clients: async () => scoped,

    ready,
    activate,
    timeoutMs: 20,
    preparedTimeoutMs,
  }
  const relay = createOfflineUpdateRelay(options)

  return {
    clients,
    activate,
    ready,
    relay,
    control,

    restart: () => createOfflineUpdateRelay(options),

    setControl: (value: ReleaseControlState) => {
      state = value
    },

    setClients: (value: UpdateClient[]) => {
      scoped = value
    },
  }
}

describe('service worker safe update relay', () => {
  it('freezes every actual scoped client before allowing explicit activation', async () => {
    const current = fixture()

    const prepared = await current.relay.handle(
      request('PREPARE_UPDATE'),
      'tab-0',
    )

    expect(prepared).toMatchObject({
      accepted: true,
      phase: 'prepared',
      clientIds: ['tab-0', 'tab-1'],
    })
    expect(current.activate).not.toHaveBeenCalled()

    for (const entry of current.clients) {
      expect(entry.messages[0]).toMatchObject({
        type: 'PREPARE_CLIENT_UPDATE',
        candidate: identity,
        initiatorClientId: 'tab-0',
      })
    }

    expect(
      await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: true, phase: 'activating' })
    expect(current.activate).toHaveBeenCalledOnce()
    expect(
      await current.relay.handle(request('ABORT_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: false, phase: 'activating' })
  })

  it.each(['busy', 'silent', 'stale', 'old-version'] as const)(
    'aborts when another tab is %s and never activates',
    async (answer) => {
      const current = fixture(['ready', answer])

      expect(
        await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0'),
      ).toMatchObject({ accepted: false, phase: 'aborted' })
      expect(
        current.clients[0].messages.map((message) => message.type),
      ).toEqual(['PREPARE_CLIENT_UPDATE', 'ABORT_CLIENT_UPDATE'])
      expect(current.activate).not.toHaveBeenCalled()
    },
  )

  it('rejects unknown, stale, wrong-client, and wrong-candidate attempts', async () => {
    const current = fixture()

    expect(
      (await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'))
        .accepted,
    ).toBe(false)
    expect(
      (
        await current.relay.handle(
          {
            ...request('PREPARE_UPDATE'),
            expected: { ...identity, appReleaseId: 'other' },
          },
          'tab-0',
        )
      ).accepted,
    ).toBe(false)

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    expect(
      (await current.relay.handle(request('ACTIVATE_UPDATE', 'stale'), 'tab-0'))
        .accepted,
    ).toBe(false)
    expect(
      (await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-1'))
        .accepted,
    ).toBe(false)
    expect(current.activate).not.toHaveBeenCalled()
  })

  it('rechecks the exact client set after preparation and aborts a newly opened tab', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    current.setClients([
      ...current.clients.map((entry) => entry.value),
      client('new-tab').value,
    ])
    expect(
      await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: false, phase: 'aborted' })
    expect(current.activate).not.toHaveBeenCalled()
  })

  it('rechecks candidate cache coherence before activation', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    current.ready.mockResolvedValue(false)
    expect(
      await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: false, phase: 'aborted' })
    expect(current.activate).not.toHaveBeenCalled()
  })

  it('does not send delayed prepare messages after a cancellation was acknowledged', async () => {
    const current = fixture()
    let release!: (ready: boolean) => void

    current.ready.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )

    const pending = current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    expect(
      await current.relay.handle(request('ABORT_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: true, phase: 'aborted' })
    release(true)
    expect((await pending).accepted).toBe(false)
    expect(current.clients.every((entry) => entry.messages.length === 0)).toBe(
      true,
    )
  })

  it('keeps activation in progress for reconciliation when skipWaiting rejects or times out', async () => {
    const current = fixture()

    current.activate.mockRejectedValue(new Error('activation transport failed'))

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')
    await expect(
      current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).rejects.toThrow('transport')

    expect(
      await current.relay.handle(request('GET_UPDATE_STATUS'), 'tab-0'),
    ).toMatchObject({ accepted: true, phase: 'activating' })
    expect(
      (await current.relay.handle(request('ABORT_UPDATE'), 'tab-0')).accepted,
    ).toBe(false)
  })

  it('safely aborts all prepared participants when the lease expires before activation', async () => {
    const current = fixture(['ready', 'ready'], 15)

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')
    await current.relay.settled()

    expect(
      await current.relay.handle(request('GET_UPDATE_STATUS'), 'tab-1'),
    ).toMatchObject({ accepted: true, phase: 'aborted' })
    expect(
      current.clients.every((entry) =>
        entry.messages.some(
          (message) => message.type === 'ABORT_CLIENT_UPDATE',
        ),
      ),
    ).toBe(true)
    expect(current.activate).not.toHaveBeenCalled()
  })

  it('lets a recorded participant reconcile and abort when the initiator has closed', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    current.setClients([current.clients[1].value])
    expect(
      await current.relay.handle(request('GET_UPDATE_STATUS'), 'tab-1'),
    ).toMatchObject({ accepted: true, phase: 'aborted' })
    expect(current.activate).not.toHaveBeenCalled()
  })
})

const query = (): CandidateStateRequest => ({
  protocol: offlineProtocol,
  version: offlineProtocolVersion,
  type: 'GET_CANDIDATE_STATE',
  requestId: crypto.randomUUID(),
  expected: identity,
})

describe('durable activation admission', () => {
  it('allows a normal idle candidate but blocks unknown control and active preparation', async () => {
    const current = fixture()

    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'idle',
    })
    current.setControl({ state: 'unknown' })
    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'unknown',
    })
    expect(
      (await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')).accepted,
    ).toBe(false)
    current.setControl({ state: 'idle' })

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'prepared',
    })

    await current.relay.handle(request('ABORT_UPDATE'), 'tab-0')

    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'idle',
    })
  })

  it('blocks newcomers during the durable write and refuses an abort before native invocation', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    let finish!: (state: ReleaseControlState) => void

    current.control.commit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    const activating = current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0')

    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))

    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'activating',
    })
    expect(current.activate).not.toHaveBeenCalled()
    expect(
      (await current.relay.handle(request('ABORT_UPDATE'), 'tab-0')).accepted,
    ).toBe(false)
    current.setControl({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
    finish({ state: 'activation-committed', attemptId: 'attempt-1' })

    await activating

    expect(current.activate).toHaveBeenCalledOnce()
  })

  it('does not return stale idle when activation starts during an asynchronous metadata read', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    let finish!: (state: ReleaseControlState) => void

    current.control.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )

    const observing = current.relay.candidateState(query())

    await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0')

    finish({ state: 'idle' })
    expect(await observing).toMatchObject({ phase: 'activating' })
  })

  it('retains a committed intent across realm reconstruction and resumes only the same authorized activation', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')
    await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0')

    const restarted = current.restart()

    expect(await restarted.candidateState(query())).toMatchObject({
      phase: 'activating',
      attemptId: 'attempt-1',
    })

    await restarted.pendingActivation()

    expect(current.activate).toHaveBeenCalledTimes(2)
    expect(
      (
        await restarted.handle(
          request('PREPARE_UPDATE', 'new-attempt'),
          'tab-new',
        )
      ).accepted,
    ).toBe(false)
    expect(
      (await restarted.handle(request('ABORT_UPDATE'), 'tab-0')).accepted,
    ).toBe(false)
    expect(await current.control.read()).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
  })

  it('definitively aborts lost provisional preparation only from valid durable idle after restart', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    const restarted = current.restart()

    expect(
      await restarted.handle(request('GET_UPDATE_STATUS'), 'tab-1'),
    ).toMatchObject({ accepted: true, phase: 'aborted' })
    current.setControl({ state: 'unknown' })
    expect(
      await restarted.handle(request('GET_UPDATE_STATUS'), 'tab-1'),
    ).toMatchObject({ accepted: false, phase: 'unknown' })
    current.setControl({ state: 'idle' })

    await current.relay.handle(request('ABORT_UPDATE'), 'tab-0')
  })

  it('allows confirmed precommit failure to abort but never calls native after a failed write', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    current.control.commit.mockRejectedValueOnce(
      new Error('write failed before persistence'),
    )
    expect(
      await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).toMatchObject({ phase: 'aborted' })
    expect(current.activate).not.toHaveBeenCalled()
  })

  it('never aborts or invokes native in a realm where a write failed after possibly persisting', async () => {
    const current = fixture()

    await current.relay.handle(request('PREPARE_UPDATE'), 'tab-0')

    current.control.commit.mockImplementationOnce(async (attemptId) => {
      current.setControl({ state: 'activation-committed', attemptId })

      throw new Error('write result lost')
    })
    expect(
      await current.relay.handle(request('ACTIVATE_UPDATE'), 'tab-0'),
    ).toMatchObject({ accepted: false, phase: 'activating' })
    expect(await current.relay.candidateState(query())).toMatchObject({
      phase: 'activating',
    })
    expect(
      (await current.relay.handle(request('ABORT_UPDATE'), 'tab-0')).accepted,
    ).toBe(false)
    expect(current.activate).not.toHaveBeenCalled()

    const restarted = current.restart()

    expect(await restarted.candidateState(query())).toMatchObject({
      phase: 'activating',
    })

    await restarted.pendingActivation()

    expect(current.activate).toHaveBeenCalledOnce()
  })
})
