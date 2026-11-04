// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { createBrowserOfflineService } from '../src/features/offline/services/browserOfflineService'
import { createOfflineTransport } from '../src/features/offline/services/offlineTransport'
import { createUpdateCoordinator } from '../src/app/updateCoordinator'
import { createTabCoordinator } from '../src/app/tabCoordination'
import {
  offlineProtocol,
  offlineProtocolVersion,
  type OfflineIdentity,
  type OfflineRequest,
  type OfflineStatus,
  type UpdateResponse,
  type CandidatePhase,
} from '../src/features/offline/services/offlineProtocol'
import { webLocks } from './fixtures/webLocks'

const current: OfflineIdentity = {
  appReleaseId: 'release-one',
  modelPackageId: 'model-one',
}
const candidate: OfflineIdentity = {
  appReleaseId: 'release-two',
  modelPackageId: 'model-two',
}
const cleanups: (() => void)[] = []

afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()

  await Promise.resolve()
})

function status(
  request: OfflineRequest,
  identity = current,
  complete = true,
): OfflineStatus {
  return {
    protocol: offlineProtocol,
    version: offlineProtocolVersion,
    requestId: request.requestId,
    type: 'STATUS',
    identity,
    matchesExpected:
      request.expected.appReleaseId === identity.appReleaseId &&
      request.expected.modelPackageId === identity.modelPackageId,
    preparation: complete ? 'ready' : 'incomplete',
    uiComplete: complete,
    classifierComplete: complete,
  }
}

function environment(
  options: {
    complete?: boolean
    waiting?: boolean
    timeout?: number
    locks?: LockManager
    candidateControl?: { phase: CandidatePhase }
  } = {},
) {
  vi.stubGlobal('MessageChannel', MessageChannel)

  const locks = options.locks ?? webLocks()
  const candidateControl = options.candidateControl ?? {
    phase: 'idle' as CandidatePhase,
  }
  let candidateAttempt: string | undefined

  vi.stubGlobal('navigator', { locks })
  vi.stubGlobal('BroadcastChannel', undefined)

  const writer = createTabCoordinator()
  const local = { dirty: false, busy: false }
  const updates = createUpdateCoordinator({
    writer,
    locks,

    isDirty: () => local.dirty,

    isBlocked: () => local.busy,
  })
  const received: OfflineRequest[] = []
  let complete = options.complete ?? true
  const active = Object.assign(new EventTarget(), {
    state: 'activated',
    postMessage: vi.fn((request: OfflineRequest, ports: MessagePort[]) => {
      received.push(request)

      if (request.type === 'PREPARE_RESOURCES') {
        complete = true
      }

      ports[0]!.postMessage(status(request, current, complete))
    }),
  })
  const waiting = Object.assign(new EventTarget(), {
    state: 'installed',
    postMessage: vi.fn(
      async (request: OfflineRequest, ports: MessagePort[]) => {
        received.push(request)

        if (
          request.type === 'GET_STATUS' ||
          request.type === 'PREPARE_RESOURCES'
        ) {
          ports[0]!.postMessage(status(request, candidate))

          return
        }

        if (request.type === 'GET_CANDIDATE_STATE') {
          ports[0]!.postMessage({
            protocol: offlineProtocol,
            version: offlineProtocolVersion,
            requestId: request.requestId,
            type: 'CANDIDATE_STATE',
            identity: candidate,
            phase: candidateControl.phase,
            ...(candidateControl.phase === 'idle' ||
            candidateControl.phase === 'unknown'
              ? {}
              : { attemptId: candidateAttempt ?? 'previous-attempt' }),
          })

          return
        }

        const base = {
          protocol: offlineProtocol,
          version: offlineProtocolVersion,
          requestId: request.requestId,
          identity: candidate,
          attemptId: request.attemptId,
          clientIds: ['this-tab'],
        }
        let response: UpdateResponse

        if (request.type === 'PREPARE_UPDATE') {
          candidateAttempt = request.attemptId
          candidateControl.phase = 'preparing'

          const accepted = await participantMessage(
            'PREPARE_CLIENT_UPDATE',
            request.attemptId,
          )

          candidateControl.phase = accepted ? 'prepared' : 'idle'
          response = {
            ...base,
            type: 'UPDATE_PREPARED',
            accepted,
            phase: accepted ? 'prepared' : 'aborted',
          }
        } else if (request.type === 'ABORT_UPDATE') {
          if (candidateControl.phase === 'activating') {
            ports[0]!.postMessage({
              ...base,
              type: 'UPDATE_ABORTED',
              accepted: false,
              phase: 'activating',
            })

            return
          }

          await participantMessage('ABORT_CLIENT_UPDATE', request.attemptId)

          candidateControl.phase = 'idle'
          response = {
            ...base,
            type: 'UPDATE_ABORTED',
            accepted: true,
            phase: 'aborted',
          }
        } else {
          if (request.type === 'ACTIVATE_UPDATE') {
            candidateControl.phase = 'activating'
          }

          response = {
            ...base,
            type:
              request.type === 'ACTIVATE_UPDATE'
                ? 'UPDATE_ACTIVATING'
                : 'UPDATE_STATUS',
            accepted: true,
            phase:
              candidateControl.phase === 'idle'
                ? 'aborted'
                : candidateControl.phase,
          }
        }

        ports[0]!.postMessage(response)
      },
    ),
  })
  const registration = Object.assign(new EventTarget(), {
    active,
    waiting: options.waiting === false ? null : waiting,
    installing: null,
  })
  const container = Object.assign(new EventTarget(), {
    controller: active,
    register: vi.fn(async () => registration),
  })

  function participantMessage(type: string, attemptId: string) {
    return new Promise<boolean>((resolve) => {
      const channel = new MessageChannel()

      channel.port1.on('message', (data: { accepted: boolean }) => {
        channel.port1.close()
        channel.port2.close()
        resolve(data.accepted)
      })
      container.dispatchEvent(
        new MessageEvent('message', {
          source: waiting as unknown as ServiceWorker,
          ports: [channel.port2 as unknown as MessagePort],
          data: {
            protocol: offlineProtocol,
            version: offlineProtocolVersion,
            requestId: crypto.randomUUID(),
            type,
            attemptId,
            candidate,
            initiatorClientId: 'this-tab',
          },
        }),
      )
    })
  }

  const reload = vi.fn()
  const confirm = vi.fn(() => true)
  const service = createBrowserOfflineService({
    production: true,
    baseUrl: '/',
    expected: current,
    serviceWorker: container as unknown as ServiceWorkerContainer,
    coordinator: updates,
    reload,
    confirm,
    timeoutMs: options.timeout ?? 1000,
  })

  service.subscribe(() => {})
  cleanups.push(() => {
    service.dispose()
    updates.dispose()
    writer.dispose()
  })

  return {
    service,
    updates,
    writer,
    local,
    active,
    waiting,
    container,
    registration,
    candidateControl,
    received,
    reload,
    confirm,
    participantMessage,

    purge: () => {
      complete = false
    },
  }
}

const permission = () => ({ allowed: true, commit: vi.fn(), cancel: vi.fn() })

describe('verified offline resources', () => {
  it('requires actual complete matching bytes instead of an active worker', async () => {
    const { service } = environment({ complete: false })

    await vi.waitFor(() => expect(service.current().preparing).toBe(false))

    expect(service.current().cacheReady).toBe(false)
    expect(service.current().tone).toBe('warning')

    await service.retry()

    expect(service.current().cacheReady).toBe(true)
    expect(service.current().tone).toBe('success')
  })
  it('removes stale readiness on focus after a cache purge and repairs resources on retry', async () => {
    const { service, purge, received } = environment()

    await vi.waitFor(() => expect(service.current().cacheReady).toBe(true))

    purge()
    window.dispatchEvent(new Event('focus'))
    expect(service.current().cacheReady).toBe(false)

    await vi.waitFor(() => expect(service.current().preparing).toBe(false))

    expect(service.current().cacheReady).toBe(false)

    await service.retry()

    expect(
      received.some((request) => request.type === 'PREPARE_RESOURCES'),
    ).toBe(true)
    expect(service.current().cacheReady).toBe(true)
  })
  it('refuses a wrong deployment and reloads stale JavaScript before admitting work', async () => {
    const { service, active, reload } = environment()

    active.postMessage.mockImplementation((request, ports) => {
      ports[0]!.postMessage(status(request, candidate))
    })
    expect(await service.verifyVersion()).toBe(false)
    expect(reload).toHaveBeenCalledOnce()

    await service.retry()

    expect(service.current().cacheReady).toBe(false)
  })
  it('ignores a late GET_STATUS from an earlier lifecycle check', async () => {
    const { service, active } = environment()

    await vi.waitFor(() => expect(service.current().cacheReady).toBe(true))

    let late: (() => void) | undefined

    active.postMessage.mockImplementationOnce((request, ports) => {
      late = () => ports[0]!.postMessage(status(request))
    })
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(late).toBeTypeOf('function'))

    active.postMessage.mockImplementation((request, ports) => {
      ports[0]!.postMessage(status(request, current, false))
    })
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(service.current().preparing).toBe(false))

    late!()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(service.current().cacheReady).toBe(false)
  })
  it('checks the active deployment even if this document still has a matching old controller', async () => {
    const { service, registration, reload } = environment()

    registration.active = Object.assign(new EventTarget(), {
      state: 'activated',
      postMessage: vi.fn((request: OfflineRequest, ports: MessagePort[]) => {
        ports[0]!.postMessage(status(request, candidate))
      }),
    })
    expect(await service.verifyVersion()).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })
  it('does not claim support in development or in a browser without a service worker', async () => {
    const { service: old } = environment()

    old.dispose()

    for (const production of [true, false]) {
      const service = createBrowserOfflineService({
        production,
        serviceWorker: null,
      })

      service.subscribe(() => {})

      await vi.waitFor(() => expect(service.current().preparing).toBe(false))

      expect(service.current().cacheReady).toBe(false)
      expect(await service.verifyVersion()).toBe(production === false)
      service.dispose()
    }
  })
})

describe('coordinated service-worker updates', () => {
  it('keeps native reload consent independent and never discards before the actual new controller is verified', async () => {
    const env = environment()

    await env.updates.admit(env.service.verifyVersion)

    const consent = permission()
    const prepare = vi.fn(async () => consent)

    env.confirm.mockReturnValue(false)

    await env.service.applyUpdate(prepare)

    expect(prepare).not.toHaveBeenCalled()
    env.confirm.mockReturnValue(true)

    await env.service.applyUpdate(async () => ({ ...consent, allowed: false }))

    expect(
      env.received.some((request) => request.type === 'PREPARE_UPDATE'),
    ).toBe(false)
    env.local.dirty = true

    const applying = env.service.applyUpdate(prepare)

    await vi.waitFor(() =>
      expect(
        env.received.some((request) => request.type === 'ACTIVATE_UPDATE'),
      ).toBe(true),
    )

    expect(consent.commit).not.toHaveBeenCalled()
    expect(consent.cancel).not.toHaveBeenCalled()
    env.active.postMessage.mockImplementation((request, ports) => {
      ports[0]!.postMessage(status(request, candidate))
    })
    env.container.dispatchEvent(new Event('controllerchange'))

    await applying

    expect(consent.commit).toHaveBeenCalledOnce()
    expect(env.reload).toHaveBeenCalledOnce()
    expect(env.updates.interaction.blocked.value).toBe(true)
  })
  it('restores its permission and admission if another tab or an old unresponsive client rejects preparation', async () => {
    const env = environment()

    await env.updates.admit(env.service.verifyVersion)

    env.waiting.postMessage.mockImplementation(async (request, ports) => {
      if (
        request.type === 'GET_STATUS' ||
        request.type === 'PREPARE_RESOURCES'
      ) {
        ports[0]!.postMessage(status(request, candidate))

        return
      }

      if (request.type === 'GET_CANDIDATE_STATE') {
        ports[0]!.postMessage({
          protocol: offlineProtocol,
          version: offlineProtocolVersion,
          requestId: request.requestId,
          type: 'CANDIDATE_STATE',
          identity: candidate,
          phase: 'idle',
        })

        return
      }

      ports[0]!.postMessage({
        protocol: offlineProtocol,
        version: offlineProtocolVersion,
        requestId: request.requestId,
        identity: candidate,
        attemptId: request.attemptId,
        clientIds: ['old-tab'],
        accepted: request.type === 'ABORT_UPDATE',
        type:
          request.type === 'ABORT_UPDATE'
            ? 'UPDATE_ABORTED'
            : 'UPDATE_PREPARED',
        phase: 'aborted',
      })
    })

    const consent = permission()

    await env.service.applyUpdate(async () => consent)

    expect(consent.cancel).toHaveBeenCalledOnce()
    expect(consent.commit).not.toHaveBeenCalled()
    expect(env.updates.interaction.blocked.value).toBe(false)
    expect(
      env.received.some((request) => request.type === 'ACTIVATE_UPDATE'),
    ).toBe(false)
  })
  it('retains both barriers after a lost activation response and accepts a late controller change', async () => {
    const env = environment({ timeout: 20 })

    await env.updates.admit(env.service.verifyVersion)

    const previous = env.waiting.postMessage.getMockImplementation()!

    env.waiting.postMessage.mockImplementation(async (request, ports) => {
      if (
        request.type === 'ACTIVATE_UPDATE' ||
        request.type === 'GET_UPDATE_STATUS'
      ) {
        return
      }

      await previous(request, ports)
    })

    const consent = permission()
    const applying = env.service.applyUpdate(async () => consent)

    await vi.waitFor(() =>
      expect(env.service.current().updateLabel).toBe(
        'Esperando la actualización…',
      ),
    )

    expect(env.writer.isLocallyBusy()).toBe(true)
    expect(env.updates.interaction.blocked.value).toBe(true)
    expect(consent.cancel).not.toHaveBeenCalled()
    env.active.postMessage.mockImplementation((request, ports) => {
      ports[0]!.postMessage(status(request, candidate))
    })
    env.container.dispatchEvent(new Event('controllerchange'))

    await applying

    expect(consent.commit).toHaveBeenCalledOnce()
    expect(env.reload).toHaveBeenCalledOnce()
  })
})

describe('durable candidate admission', () => {
  it('retains its own provisional permission when neither abort nor durable idle can be confirmed', async () => {
    const env = environment({ timeout: 20 })

    await env.updates.admit(env.service.verifyVersion)

    const previous = env.waiting.postMessage.getMockImplementation()!

    env.waiting.postMessage.mockImplementation(async (request, ports) => {
      if (
        request.type === 'GET_STATUS' ||
        request.type === 'PREPARE_RESOURCES'
      ) {
        return previous(request, ports)
      }

      if (request.type === 'GET_CANDIDATE_STATE') {
        ports[0]!.postMessage({
          protocol: offlineProtocol,
          version: offlineProtocolVersion,
          requestId: request.requestId,
          type: 'CANDIDATE_STATE',
          identity: candidate,
          phase: 'unknown',
        })

        return
      }

      ports[0]!.postMessage({
        protocol: offlineProtocol,
        version: offlineProtocolVersion,
        requestId: request.requestId,
        identity: candidate,
        attemptId: request.attemptId,
        type:
          request.type === 'PREPARE_UPDATE'
            ? 'UPDATE_PREPARED'
            : 'UPDATE_ABORTED',
        accepted: false,
        phase: 'unknown',
        clientIds: [],
      })
    })

    const consent = permission()
    const applying = env.service.applyUpdate(async () => consent)

    await vi.waitFor(() =>
      expect(env.service.current().updateLabel).toBe(
        'Esperando la actualización…',
      ),
    )

    expect(env.writer.isLocallyBusy()).toBe(true)
    expect(env.updates.interaction.blocked.value).toBe(true)
    expect(env.updates.isPrepared()).toBe(true)
    expect(consent.cancel).not.toHaveBeenCalled()
    expect(consent.commit).not.toHaveBeenCalled()
    expect(
      env.received.some((request) => request.type === 'ACTIVATE_UPDATE'),
    ).toBe(false)
    env.service.dispose()
    env.updates.dispose()

    await applying
  })
  it('keeps a newcomer blocked after the updater closes while native activation is still pending', async () => {
    const locks = webLocks()
    const candidateControl = { phase: 'idle' as CandidatePhase }
    const updater = environment({ locks, candidateControl })

    await updater.updates.admit(updater.service.verifyVersion)

    const applying = updater.service.applyUpdate(async () => permission())

    await vi.waitFor(() =>
      expect(
        updater.received.some((request) => request.type === 'ACTIVATE_UPDATE'),
      ).toBe(true),
    )

    const newcomer = environment({ locks, candidateControl })
    const admission = newcomer.updates.admit(newcomer.service.verifyVersion)

    expect(newcomer.updates.interaction.blocked.value).toBe(true)
    updater.service.dispose()
    updater.updates.dispose()

    await applying

    expect(await admission).toBe(false)
    expect(newcomer.updates.interaction.blocked.value).toBe(true)
    expect(newcomer.container.controller).toBe(newcomer.active)
    expect(newcomer.registration.active).toBe(newcomer.active)
    expect(newcomer.reload).not.toHaveBeenCalled()
    expect(
      newcomer.received.some(
        (request) => request.type === 'GET_CANDIDATE_STATE',
      ),
    ).toBe(true)
  })

  it.each([
    'preparing',
    'prepared',
    'activating',
    'unknown',
  ] as CandidatePhase[])(
    'blocks candidate %s and permits only a later explicit idle response',
    async (phase) => {
      const env = environment({ candidateControl: { phase } })

      expect(await env.updates.admit(env.service.verifyVersion)).toBe(false)
      expect(env.updates.interaction.blocked.value).toBe(true)
      env.candidateControl.phase = 'idle'
      expect(await env.updates.admit(env.service.verifyVersion)).toBe(true)
    },
  )

  it('admits first installation without a waiting candidate and an ordinary explicitly idle waiting candidate', async () => {
    for (const waiting of [false, true]) {
      const env = environment({ waiting })

      expect(await env.updates.admit(env.service.verifyVersion)).toBe(true)
      expect(env.updates.interaction.blocked.value).toBe(false)
      expect(
        env.received.some((request) => request.type === 'GET_CANDIDATE_STATE'),
      ).toBe(waiting)
    }
  })

  it.each([
    'timeout',
    'old-version',
    'wrong-identity',
    'malformed-idle',
  ] as const)('never admits a candidate with %s control', async (failure) => {
    const env = environment({ timeout: 20 })
    const previous = env.waiting.postMessage.getMockImplementation()!

    env.waiting.postMessage.mockImplementation(async (request, ports) => {
      if (request.type !== 'GET_CANDIDATE_STATE') {
        return previous(request, ports)
      }

      if (failure === 'timeout') {
        return
      }

      ports[0]!.postMessage({
        protocol: offlineProtocol,
        version: failure === 'old-version' ? 1 : offlineProtocolVersion,
        type: 'CANDIDATE_STATE',
        requestId: request.requestId,
        phase: 'idle',
        identity: failure === 'wrong-identity' ? current : candidate,
        ...(failure === 'malformed-idle'
          ? { attemptId: 'contradictory-active-attempt' }
          : {}),
      })
    })
    expect(await env.updates.admit(env.service.verifyVersion)).toBe(false)
    expect(env.updates.interaction.blocked.value).toBe(true)
  })

  it.each(['active', 'controller', 'waiting', 'state'] as const)(
    'invalidates a reply if %s changes during candidate inspection',
    async (changed) => {
      const env = environment()
      const replacement = Object.assign(new EventTarget(), {
        state: changed === 'waiting' ? 'installed' : 'activated',
        postMessage: vi.fn(
          async (request: OfflineRequest, ports: MessagePort[]) => {
            if (request.type === 'GET_CANDIDATE_STATE') {
              ports[0]!.postMessage({
                protocol: offlineProtocol,
                version: offlineProtocolVersion,
                requestId: request.requestId,
                type: 'CANDIDATE_STATE',
                identity: candidate,
                phase: 'activating',
                attemptId: 'other-attempt',
              })
            } else {
              ports[0]!.postMessage(status(request, candidate))
            }
          },
        ),
      })
      const previous = env.waiting.postMessage.getMockImplementation()!
      let replaced = false

      env.waiting.postMessage.mockImplementation(async (request, ports) => {
        if (request.type === 'GET_CANDIDATE_STATE' && !replaced) {
          replaced = true

          if (changed === 'active') {
            env.registration.active = replacement
          } else if (changed === 'controller') {
            env.container.controller = replacement
          } else if (changed === 'waiting') {
            env.registration.waiting = replacement
          } else {
            env.waiting.state = 'activating'
          }
        }

        return previous(request, ports)
      })
      expect(await env.updates.admit(env.service.verifyVersion)).toBe(false)
      expect(env.updates.interaction.blocked.value).toBe(true)
      expect(replaced).toBe(true)
    },
  )

  it('restores a lost provisional preparation only after a restarted candidate proves durable idle', async () => {
    const env = environment()

    await env.updates.admit(env.service.verifyVersion)

    expect(
      await env.participantMessage('PREPARE_CLIENT_UPDATE', 'lost-attempt'),
    ).toBe(true)
    expect(env.updates.interaction.blocked.value).toBe(true)
    env.candidateControl.phase = 'unknown'
    window.dispatchEvent(new Event('focus'))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(env.updates.interaction.blocked.value).toBe(true)
    env.candidateControl.phase = 'idle'
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() =>
      expect(env.updates.interaction.blocked.value).toBe(false),
    )
  })
})

describe('MessageChannel request lifecycle', () => {
  it('ignores stale correlation IDs and protocol versions, closes requests on disposal', async () => {
    vi.stubGlobal('MessageChannel', MessageChannel)

    const transport = createOfflineTransport(100)
    const request: OfflineRequest = {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      requestId: 'current',
      type: 'GET_STATUS',
      expected: current,
    }
    const worker = {
      postMessage: (_: unknown, ports: MessagePort[]) => {
        ports[0]!.postMessage({ ...status(request), requestId: 'old' })
        ports[0]!.postMessage({ ...status(request), version: 0 })
        ports[0]!.postMessage(status(request, current, false))
      },
    } as ServiceWorker

    await expect(transport.request(worker, request)).resolves.toMatchObject({
      preparation: 'incomplete',
    })

    const pending = transport.request(
      { postMessage() {} } as unknown as ServiceWorker,
      request,
    )
    const stopped = expect(pending).rejects.toMatchObject({ delivered: true })

    transport.dispose()

    await stopped
  })
})
