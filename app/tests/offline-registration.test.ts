// @vitest-environment jsdom
import { MessageChannel } from 'node:worker_threads'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserOfflineService } from '../src/features/offline/services/browserOfflineService'
import {
  offlineProtocol,
  offlineProtocolVersion,
  type OfflineRequest,
} from '../src/features/offline/services/offlineProtocol'

const identity = {
  appReleaseId: 'first-release',
  modelPackageId: 'unchanged-package',
}
const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

function environment() {
  vi.stubGlobal('MessageChannel', MessageChannel)

  const installing = Object.assign(new EventTarget(), {
    state: 'installing',
    postMessage: vi.fn(),
  })
  const active = Object.assign(new EventTarget(), {
    state: 'activated',
    postMessage: vi.fn((request: OfflineRequest, ports: MessagePort[]) => {
      ports[0]!.postMessage({
        protocol: offlineProtocol,
        version: offlineProtocolVersion,
        requestId: request.requestId,
        type: 'STATUS',
        identity,
        matchesExpected: true,
        preparation: 'ready',
        uiComplete: true,
        classifierComplete: true,
      })
    }),
  })
  const failed = Object.assign(new EventTarget(), {
    active: null as typeof active | null,
    waiting: null as typeof active | null,
    installing: installing as typeof installing | null,
  })
  const healthy = Object.assign(new EventTarget(), {
    active,
    waiting: null,
    installing: null,
  })
  let completeNext!: () => void
  const next = new Promise<typeof healthy>((resolve) => {
    completeNext = () => resolve(healthy)
  })
  const container = Object.assign(new EventTarget(), {
    controller: null as typeof active | null,
    register: vi.fn(async () => failed as typeof failed | typeof healthy),
  })

  container.register.mockImplementationOnce(async () => failed)
  container.register.mockImplementation(async () => {
    const value = await next

    container.controller = value.active

    return value
  })

  const service = createBrowserOfflineService({
    production: true,
    expected: identity,
    baseUrl: '/tool/',
    serviceWorker: container as unknown as ServiceWorkerContainer,
    timeoutMs: 1000,
    reload: vi.fn(),
  })

  service.subscribe(() => {})
  cleanups.push(service.dispose)

  async function failAfterResolvedRegistration() {
    await flushPromises()

    expect(container.register).toHaveBeenCalledOnce()
    expect(service.current().cacheReady).toBe(false)
    installing.state = 'redundant'
    failed.installing = null
    installing.dispatchEvent(new Event('statechange'))

    await flushPromises()

    expect(service.current().canRetry).toBe(true)
  }

  return {
    service,
    container,
    failed,
    healthy,
    active,
    installing,
    completeNext,
    failAfterResolvedRegistration,
  }
}

describe('first-install recovery without document reload', () => {
  it('re-registers after register resolved but the later first installation became redundant', async () => {
    const env = environment()

    await env.failAfterResolvedRegistration()

    env.completeNext()
    await env.service.retry()

    expect(env.container.register).toHaveBeenCalledTimes(2)
    expect(env.service.current().cacheReady).toBe(true)
    expect(await env.service.verifyVersion()).toBe(true)
    expect(
      env.active.postMessage.mock.calls.some(
        ([request]) => request.type === 'PREPARE_RESOURCES',
      ),
    ).toBe(true)
  })

  it('deduplicates concurrent explicit retries while the replacement registration is pending', async () => {
    const env = environment()

    await env.failAfterResolvedRegistration()

    const first = env.service.retry()
    const second = env.service.retry()

    try {
      await flushPromises()

      expect(env.container.register).toHaveBeenCalledTimes(2)
    } finally {
      env.completeNext()

      await Promise.all([first, second])
    }

    expect(env.service.current().cacheReady).toBe(true)
  })

  it('does not let a late obsolete installer discard the healthy replacement registration', async () => {
    const env = environment()

    await env.failAfterResolvedRegistration()

    env.completeNext()

    await env.service.retry()

    env.installing.dispatchEvent(new Event('statechange'))

    await flushPromises()
    await env.service.retry()

    expect(env.container.register).toHaveBeenCalledTimes(2)
    expect(env.service.current().cacheReady).toBe(true)
    expect(await env.service.verifyVersion()).toBe(true)
  })

  it('preserves a working active registration when a later candidate installer fails', async () => {
    const env = environment()

    env.failed.active = env.active
    env.container.controller = env.active

    await flushPromises()

    env.failed.installing = null
    env.installing.state = 'redundant'
    env.installing.dispatchEvent(new Event('statechange'))

    await flushPromises()
    await env.service.retry()

    expect(env.container.register).toHaveBeenCalledOnce()
    expect(env.service.current().cacheReady).toBe(true)
  })
})
