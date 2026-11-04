import { describe, expect, it, vi } from 'vitest'
import {
  createReleaseControl,
  releaseControlCacheName,
} from '../src/features/offline/services/releaseControl'
import {
  offlineProtocol,
  offlineProtocolVersion,
  type OfflineIdentity,
} from '../src/features/offline/services/offlineProtocol'

const scope = 'https://local.example/tool/'
const identity = { appReleaseId: 'release-b', modelPackageId: 'package-a' }
const record = (changes: Record<string, unknown> = {}) => ({
  protocol: offlineProtocol,
  version: offlineProtocolVersion,
  ...identity,
  state: 'idle',
  attemptId: null,
  ...changes,
})
const recordKey = (base = scope, release: OfflineIdentity = identity) =>
  `${base}__release-control__/${encodeURIComponent(release.appReleaseId)}/${encodeURIComponent(release.modelPackageId)}`

function memoryStorage() {
  const buckets = new Map<string, Map<string, Response>>()
  const faults = {
    open: false,
    read: false,
    beforeWrite: false,
    afterWrite: false,
    readAfterWrite: false,
  }
  const key = (request: Request | string | URL) =>
    typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.href
        : request.url
  const bucket = (name: string) => {
    if (!buckets.has(name)) {
      buckets.set(name, new Map())
    }

    return buckets.get(name)!
  }
  const put = vi.fn(
    async (
      name: string,
      request: Request | string | URL,
      response: Response,
    ) => {
      if (faults.beforeWrite) {
        throw new Error('write failed')
      }

      bucket(name).set(key(request), response.clone())

      if (faults.readAfterWrite) {
        faults.read = true
      }

      if (faults.afterWrite) {
        throw new Error('write outcome uncertain')
      }
    },
  )
  const storage: CacheStorage = {
    open: vi.fn(async (name: string): Promise<Cache> => {
      if (faults.open) {
        throw new Error('cache unavailable')
      }

      return {
        async match(request) {
          if (faults.read) {
            throw new Error('read failed')
          }

          return bucket(name).get(key(request))?.clone()
        },

        put: (request, response) => put(name, request, response),

        async add() {
          throw new Error('unexpected cache.add')
        },

        async addAll() {
          throw new Error('unexpected cache.addAll')
        },

        async delete(request) {
          return bucket(name).delete(key(request))
        },

        async keys() {
          return [...bucket(name).keys()].map((url) => new Request(url))
        },

        async matchAll() {
          return [...bucket(name).values()].map((response) => response.clone())
        },
      }
    }),
    delete: vi.fn(async (name: string) => buckets.delete(name)),

    async has(name) {
      return buckets.has(name)
    },

    async keys() {
      return [...buckets.keys()]
    },

    async match(request) {
      for (const entries of buckets.values()) {
        const response = entries.get(key(request))

        if (response) {
          return response.clone()
        }
      }

      return undefined
    },
  }
  const seed = (value: unknown, base = scope, release = identity) =>
    bucket(releaseControlCacheName(base)).set(
      recordKey(base, release),
      new Response(JSON.stringify(value)),
    )

  return {
    storage,
    faults,
    put,
    buckets,
    seed,

    control: (base = scope, release: OfflineIdentity = identity) =>
      createReleaseControl({ identity: release, scope: base, storage }),
  }
}

describe('durable service worker release control', () => {
  it('keeps absent metadata unknown without writing during construction or ordinary reads', async () => {
    const store = memoryStorage()
    const first = store.control()

    expect(store.storage.open).not.toHaveBeenCalled()
    expect(await first.read()).toEqual({ state: 'unknown' })
    expect(await store.control().read()).toEqual({ state: 'unknown' })
    expect(store.put).not.toHaveBeenCalled()
  })

  it('writes explicit idle only during installation using the exact versioned metadata schema', async () => {
    const store = memoryStorage()

    await store.control().install()

    expect(offlineProtocolVersion).toBe(2)
    expect(await store.control().read()).toEqual({ state: 'idle' })
    expect(store.put).toHaveBeenCalledOnce()

    const [name, key, response] = store.put.mock.calls[0]

    expect(name).toBe('einvoice-release-control-%2Ftool%2F')
    expect(key).toBe(recordKey())
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(await response.clone().json()).toEqual(record())
  })

  it('persists the committed attempt when a worker and control instance are reconstructed', async () => {
    const store = memoryStorage()

    await store.control().install()

    expect(await store.control().commit('attempt-1')).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })

    const writes = store.put.mock.calls.length

    expect(await store.control().read()).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
    expect(store.put).toHaveBeenCalledTimes(writes)
    expect(await store.put.mock.calls[1][2].clone().json()).toEqual(
      record({ state: 'activation-committed', attemptId: 'attempt-1' }),
    )
  })

  it('does not replace an already committed attempt or authorize one with missing metadata', async () => {
    const store = memoryStorage()

    expect(await store.control().commit('attempt-1')).toEqual({
      state: 'unknown',
    })
    expect(store.put).not.toHaveBeenCalled()

    await store.control().install()
    await store.control().commit('attempt-1')

    expect(await store.control().commit('attempt-2')).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
    expect(store.put).toHaveBeenCalledTimes(2)
  })

  it('waits for the durable write before reporting a committed attempt', async () => {
    const store = memoryStorage()
    const control = store.control()

    await control.install()

    let release!: () => void
    let entered!: () => void
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = store.storage.open

    vi.spyOn(store.storage, 'open').mockImplementation(async (name) => {
      const cache = await open(name)

      return {
        ...cache,

        async put(request, response) {
          entered()

          await blocked
          await cache.put(request, response)
        },
      }
    })

    let resolved = false
    const committing = control.commit('attempt-1').then((result) => {
      resolved = true

      return result
    })

    await writing

    expect(resolved).toBe(false)
    expect(await control.read()).toEqual({ state: 'idle' })
    release()
    expect(await committing).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
  })

  it.each(['a', 'a'.repeat(200)])(
    'accepts a bounded opaque attempt',
    async (attemptId) => {
      const store = memoryStorage()

      await store.control().install()

      expect(await store.control().commit(attemptId)).toEqual({
        state: 'activation-committed',
        attemptId,
      })
    },
  )

  it.each([
    ['empty', ''],
    ['oversize', 'a'.repeat(201)],
  ])(
    'refuses an %s opaque attempt without writing',
    async (_description, attempt) => {
      const store = memoryStorage()

      await store.control().install()

      expect(await store.control().commit(attempt)).toEqual({
        state: 'unknown',
      })
      expect(store.put).toHaveBeenCalledOnce()
    },
  )

  it.each([
    ['null record', null],
    ['array record', []],
    ['primitive record', 'idle'],
    ['missing fields', { state: 'idle' }],
    ['other protocol', record({ protocol: 'other' })],
    ['old schema', record({ version: 1 })],
    ['non-numeric schema', record({ version: '2' })],
    ['wrong app release', record({ appReleaseId: 'release-a' })],
    ['wrong model package', record({ modelPackageId: 'package-b' })],
    ['unknown state', record({ state: 'unknown' })],
    ['idle with attempt', record({ attemptId: 'attempt-1' })],
    ['committed without attempt', record({ state: 'activation-committed' })],
    [
      'empty committed attempt',
      record({ state: 'activation-committed', attemptId: '' }),
    ],
    [
      'oversize committed attempt',
      record({ state: 'activation-committed', attemptId: 'a'.repeat(201) }),
    ],
    [
      'non-string committed attempt',
      record({ state: 'activation-committed', attemptId: 42 }),
    ],
    ['extra user-data field', record({ invoice: {} })],
    ['extra control field', record({ confirmed: true })],
  ])(
    'treats %s as unknown and never repairs it to idle',
    async (_description, value) => {
      const store = memoryStorage()

      store.seed(value)
      expect(await store.control().read()).toEqual({ state: 'unknown' })
      expect(await store.control().commit('attempt-1')).toEqual({
        state: 'unknown',
      })
      expect(store.put).not.toHaveBeenCalled()
    },
  )

  it('keeps malformed JSON and non-success responses unknown', async () => {
    const store = memoryStorage()
    const entries = new Map([[recordKey(), new Response('{broken')]])

    store.buckets.set(releaseControlCacheName(scope), entries)
    expect(await store.control().read()).toEqual({ state: 'unknown' })
    entries.set(
      recordKey(),
      new Response(JSON.stringify(record()), { status: 503 }),
    )
    expect(await store.control().read()).toEqual({ state: 'unknown' })
    expect(store.put).not.toHaveBeenCalled()
  })

  it.each(['open', 'read'] as const)(
    'keeps a %s failure unknown without resetting persisted intent',
    async (fault) => {
      const store = memoryStorage()

      store.seed(
        record({ state: 'activation-committed', attemptId: 'attempt-1' }),
      )
      store.faults[fault] = true
      expect(await store.control().read()).toEqual({ state: 'unknown' })
      expect(await store.control().commit('attempt-2')).toEqual({
        state: 'unknown',
      })
      store.faults[fault] = false
      expect(await store.control().read()).toEqual({
        state: 'activation-committed',
        attemptId: 'attempt-1',
      })
      expect(store.put).not.toHaveBeenCalled()
    },
  )

  it('does not establish idle when the actual install write fails', async () => {
    const store = memoryStorage()

    store.faults.beforeWrite = true

    await expect(store.control().install()).rejects.toThrow('write failed')

    store.faults.beforeWrite = false
    expect(await store.control().read()).toEqual({ state: 'unknown' })
  })

  it('propagates a failed commit write and preserves the last verified state', async () => {
    const store = memoryStorage()

    await store.control().install()

    store.faults.beforeWrite = true

    await expect(store.control().commit('attempt-1')).rejects.toThrow(
      'write failed',
    )

    store.faults.beforeWrite = false
    expect(await store.control().read()).toEqual({ state: 'idle' })
  })

  it('preserves durable intent when a write stores the commit but its completion fails', async () => {
    const store = memoryStorage()

    await store.control().install()

    store.faults.afterWrite = true

    await expect(store.control().commit('attempt-1')).rejects.toThrow(
      'uncertain',
    )

    store.faults.afterWrite = false
    expect(await store.control().read()).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
  })

  it('returns unknown if commit readback fails and recovers committed intent after reconstruction', async () => {
    const store = memoryStorage()

    await store.control().install()

    store.faults.readAfterWrite = true
    expect(await store.control().commit('attempt-1')).toEqual({
      state: 'unknown',
    })
    store.faults.read = false
    store.faults.readAfterWrite = false
    expect(await store.control().read()).toEqual({
      state: 'activation-committed',
      attemptId: 'attempt-1',
    })
    expect(store.put).toHaveBeenCalledTimes(2)
  })

  it('isolates app releases, model packages, and registration scopes on the same origin', async () => {
    const store = memoryStorage()

    await store.control().install()
    await store.control().commit('attempt-1')

    const alternatives: [string, OfflineIdentity][] = [
      [scope, { ...identity, appReleaseId: 'release-c' }],
      [scope, { ...identity, modelPackageId: 'package-b' }],
      ['https://local.example/other/', identity],
    ]

    for (const [base, release] of alternatives) {
      const control = store.control(base, release)

      expect(await control.read()).toEqual({ state: 'unknown' })

      await control.install()

      expect(await control.read()).toEqual({ state: 'idle' })
      expect(await store.control().read()).toEqual({
        state: 'activation-committed',
        attemptId: 'attempt-1',
      })
    }

    expect(releaseControlCacheName(scope)).not.toBe(
      releaseControlCacheName('https://local.example/other/'),
    )
  })

  it('uses an encoded metadata key and leaves the static resource cache untouched', async () => {
    const store = memoryStorage()
    const staticName = 'einvoice-%2Ftool%2F-precache-v2-release-b'

    store.buckets.set(
      staticName,
      new Map([[scope + 'index.html', new Response('static application')]]),
    )

    const release = {
      appReleaseId: 'release /?#',
      modelPackageId: 'package /?#',
    }

    await store.control(scope, release).install()
    await store.control(scope, release).commit('attempt-1')

    expect(store.put.mock.calls.map(([name, key]) => [name, key])).toEqual([
      [releaseControlCacheName(scope), recordKey(scope, release)],
      [releaseControlCacheName(scope), recordKey(scope, release)],
    ])
    expect(
      await store.buckets
        .get(staticName)!
        .get(scope + 'index.html')!
        .clone()
        .text(),
    ).toBe('static application')
    expect(store.storage.delete).not.toHaveBeenCalled()
  })
})
