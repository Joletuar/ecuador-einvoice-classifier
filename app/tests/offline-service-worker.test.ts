import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  offlineProtocol,
  offlineProtocolVersion,
  type OfflineRequest,
  type OfflineResponse,
} from '../src/features/offline/services/offlineProtocol'
import {
  createReleaseControl,
  releaseControlCacheName,
} from '../src/features/offline/services/releaseControl'
import type { PrecacheResource } from '../src/features/offline/services/offlineResources'

const state = vi.hoisted(() => ({
  identity: { appReleaseId: 'release-b', modelPackageId: 'package' },
  classifier: [] as {
    url: string
    sha256: string
  }[],
  cacheName: 'einvoice-%2Ftool%2F-precache-v2-release-b',
}))

vi.mock('virtual:app-release', () => ({
  appRelease: state.identity,
  classifierAssets: state.classifier,
}))
vi.mock('workbox-core', () => ({
  cacheNames: { precache: state.cacheName },
  setCacheNameDetails: vi.fn(),
}))
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),

  getCacheKeyForURL: (url: string) => `${url}?__WB_REVISION__=release-b`,

  createHandlerBoundToURL: vi.fn(),
}))
vi.mock('workbox-routing', () => ({
  NavigationRoute: vi.fn(),
  registerRoute: vi.fn(),
}))

const scope = 'https://local.example/tool/'

type Listener = (event: {
  data?: unknown
  ports?: MessagePort[]
  source?: { id: string }
  waitUntil(promise: Promise<unknown>): void
}) => void

let resources: PrecacheResource[]
let cache: Map<string, string>
let controlEntries: Map<string, string>
let listeners: Map<string, Listener>
let names: Set<string>
let claim: ReturnType<typeof vi.fn>
let skipWaiting: ReturnType<typeof vi.fn>
const sha = (value: string, encoding: 'hex' | 'base64') =>
  createHash('sha256').update(value).digest(encoding)
const key = (path: string) =>
  `${new URL(path, scope).href}?__WB_REVISION__=release-b`

beforeEach(async () => {
  vi.resetModules()
  cache = new Map()
  controlEntries = new Map()
  resources = []
  state.classifier.splice(0)

  for (const path of [
    'index.html',
    'assets/app.js',
    'assets/worker.js',
    ...Array.from({ length: 9 }, (_, i) => `classifier/package/resource-${i}`),
  ]) {
    const body = `expected body of ${path}`

    resources.push({
      url: path,
      integrity: `sha256-${sha(body, 'base64')}`,
      revision: 'release-b',
    })
    cache.set(key(path), body)

    if (path.startsWith('classifier/')) {
      state.classifier.push({
        url: new URL(path, scope).href,
        sha256: sha(body, 'hex'),
      })
    }
  }

  names = new Set([
    state.cacheName,
    'einvoice-%2Ftool%2F-precache-v2-release-a',
    'unrelated-cache',
  ])
  listeners = new Map()
  claim = vi.fn(async () => undefined)
  skipWaiting = vi.fn(async () => undefined)
  vi.stubGlobal('self', {
    __WB_MANIFEST: resources,
    registration: { scope },
    clients: {
      claim,

      get: async (id: string) => ({ id, type: 'window', url: scope }),

      matchAll: async () => [],
    },
    skipWaiting,

    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
  })
  vi.stubGlobal('caches', {
    open: async (name: string) => {
      names.add(name)

      const entries =
        name === releaseControlCacheName(scope) ? controlEntries : cache

      return {
        match: async (url: string) =>
          entries.has(url) ? new Response(entries.get(url)) : undefined,

        put: async (url: string, response: Response) =>
          entries.set(url, await response.text()),
      }
    },

    keys: async () => [...names],

    delete: async (name: string) => names.delete(name),
  })

  await import('../src/sw')
})

afterEach(() => vi.unstubAllGlobals())

async function message(request: unknown): Promise<OfflineResponse> {
  let response: OfflineResponse | undefined
  let work: Promise<unknown> | undefined

  listeners.get('message')!({
    data: request,
    ports: [
      {
        postMessage: (value: OfflineResponse) => {
          response = value
        },
      } as MessagePort,
    ],
    source: { id: 'tab-1' },

    waitUntil: (promise) => {
      work = promise
    },
  })

  await work

  return response!
}

const statusRequest = (
  type: 'GET_STATUS' | 'PREPARE_RESOURCES' = 'GET_STATUS',
): OfflineRequest => ({
  protocol: offlineProtocol,
  version: offlineProtocolVersion,
  requestId: crypto.randomUUID(),
  type,
  expected: state.identity,
})

describe('service worker cache lifecycle', () => {
  it('reports readiness only for the actual complete cache and expected release', async () => {
    expect(await message(statusRequest())).toMatchObject({
      preparation: 'ready',
      uiComplete: true,
      classifierComplete: true,
      matchesExpected: true,
    })
    expect(
      await message({
        ...statusRequest(),
        expected: { ...state.identity, appReleaseId: 'release-a' },
      }),
    ).toMatchObject({
      preparation: 'incomplete',
      matchesExpected: false,
      uiComplete: false,
      classifierComplete: false,
    })
    cache.delete(key('classifier/package/resource-8'))
    expect(await message(statusRequest())).toMatchObject({
      preparation: 'incomplete',
      uiComplete: true,
      classifierComplete: false,
    })
    expect(names.has('einvoice-%2Ftool%2F-precache-v2-release-a')).toBe(true)
  })

  it('performs real repair after reconnect and rejects a false 200 fallback body', async () => {
    const asset = 'assets/worker.js'

    cache.delete(key(asset))

    const fetchResource = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response('<html>fallback</html>'),
    )

    vi.stubGlobal('fetch', fetchResource)
    expect(await message(statusRequest('PREPARE_RESOURCES'))).toMatchObject({
      preparation: 'error',
      uiComplete: false,
    })
    expect(cache.has(key(asset))).toBe(false)
    expect(names.has('einvoice-%2Ftool%2F-precache-v2-release-a')).toBe(true)
    fetchResource.mockResolvedValue(new Response(`expected body of ${asset}`))
    expect(await message(statusRequest('PREPARE_RESOURCES'))).toMatchObject({
      preparation: 'ready',
      uiComplete: true,
      classifierComplete: true,
    })

    const request = fetchResource.mock.calls[0][0]

    expect(request.cache).toBe('reload')
  })

  it('cleans older own caches only after successful activation and then claims clients', async () => {
    names.add(releaseControlCacheName(scope))
    controlEntries.set('retained-control', 'public release metadata')

    let work: Promise<unknown> | undefined

    listeners.get('activate')!({
      waitUntil: (promise) => {
        work = promise
      },
    })

    await work

    expect(names).toEqual(
      new Set([
        state.cacheName,
        'unrelated-cache',
        releaseControlCacheName(scope),
      ]),
    )
    expect(controlEntries.get('retained-control')).toBe(
      'public release metadata',
    )
    expect(claim).toHaveBeenCalledOnce()
  })

  it('retains the old usable cache and does not claim if candidate activation is incomplete', async () => {
    cache.delete(key('classifier/package/resource-0'))

    let work: Promise<unknown> | undefined

    listeners.get('activate')!({
      waitUntil: (promise) => {
        work = promise
      },
    })

    await expect(work).rejects.toThrow('incompleta')

    expect(names.has('einvoice-%2Ftool%2F-precache-v2-release-a')).toBe(true)
    expect(claim).not.toHaveBeenCalled()
  })

  it('ignores the historical generic SKIP_WAITING message', () => {
    const waitUntil = vi.fn()

    listeners.get('message')!({
      data: { type: 'SKIP_WAITING' },
      ports: [],
      waitUntil,
    })
    expect(waitUntil).not.toHaveBeenCalled()
    expect(skipWaiting).not.toHaveBeenCalled()
  })

  it('writes idle only on actual install and excludes release metadata from static integrity inspection', async () => {
    const query = { ...statusRequest(), type: 'GET_CANDIDATE_STATE' }

    expect(await message(query)).toMatchObject({
      type: 'CANDIDATE_STATE',
      phase: 'unknown',
    })
    expect(controlEntries.size).toBe(0)

    let installing: Promise<unknown> | undefined

    listeners.get('install')!({
      waitUntil: (work) => {
        installing = work
      },
    })

    await installing

    expect(await message(query)).toMatchObject({ phase: 'idle' })
    expect(controlEntries.size).toBe(1)
    expect(await message(statusRequest())).toMatchObject({
      preparation: 'ready',
    })
    expect(cache.size).toBe(resources.length)
  })

  it('retains committed intent across a real module reconstruction and resumes the same native request', async () => {
    const control = createReleaseControl({
      identity: state.identity,
      scope,
      storage: caches,
    })

    await control.install()
    await control.commit('authorized-attempt')

    listeners.clear()
    vi.resetModules()

    await import('../src/sw')

    expect(
      await message({ ...statusRequest(), type: 'GET_CANDIDATE_STATE' }),
    ).toMatchObject({
      type: 'CANDIDATE_STATE',
      phase: 'activating',
      attemptId: 'authorized-attempt',
    })
    expect(skipWaiting).toHaveBeenCalledOnce()
    expect(await control.read()).toEqual({
      state: 'activation-committed',
      attemptId: 'authorized-attempt',
    })
  })

  it('rejects version-one clients instead of treating their acknowledgements as safe admission', async () => {
    expect(await message({ ...statusRequest(), version: 1 })).toBeUndefined()
    expect(skipWaiting).not.toHaveBeenCalled()
  })
})
