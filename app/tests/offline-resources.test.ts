import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  inspectResources,
  repairResources,
  type PrecacheResource,
} from '../src/features/offline/services/offlineResources'

const origin = 'https://local.example/tool/'
const digest = (body: string, encoding: 'hex' | 'base64') =>
  createHash('sha256').update(body).digest(encoding)

function fixture() {
  const classifier = Array.from({ length: 9 }, (_, index) => ({
    url: `classifier/package/file-${index}`,
    sha256: digest(`classifier-${index}`, 'hex'),
  }))
  const bodies = new Map<string, string>([
    ['index.html', '<html>local application</html>'],
    ['assets/app.js', 'application'],
    ['assets/worker.js', 'classification worker'],
    ...classifier.map((asset, index): [string, string] => [
      asset.url,
      `classifier-${index}`,
    ]),
  ])
  const resources: PrecacheResource[] = [...bodies].map(([url, body]) => ({
    url,
    revision: 'current',
    integrity: `sha256-${digest(body, 'base64')}`,
  }))
  const cache = new Map(
    [...bodies].map(([url, body]) => [new URL(url, origin).href, body]),
  )
  const inspect = () =>
    inspectResources({
      resources,
      classifier,
      origin,

      async read(url) {
        const body = cache.get(url)

        return body === undefined ? undefined : new Response(body)
      },
    })

  return { resources, classifier, bodies, cache, inspect }
}

describe('offline resource readiness', () => {
  it('requires complete UI, Worker, and all nine byte-verified classifier assets', async () => {
    const current = fixture()

    expect(await current.inspect()).toMatchObject({
      uiComplete: true,
      classifierComplete: true,
      invalid: [],
    })
    current.cache.delete(new URL('assets/worker.js', origin).href)
    expect(await current.inspect()).toMatchObject({
      uiComplete: false,
      classifierComplete: true,
    })
  })

  it.each(['classifier/package/file-0', 'classifier/package/file-8'])(
    'detects missing and corrupted classifier metadata or runtime: %s',
    async (path) => {
      const current = fixture()

      current.cache.delete(new URL(path, origin).href)
      expect((await current.inspect()).classifierComplete).toBe(false)
      current.cache.set(new URL(path, origin).href, 'corrupted')
      expect((await current.inspect()).classifierComplete).toBe(false)
    },
  )

  it('rejects a false HTTP 200 HTML body and a fully purged cache', async () => {
    const current = fixture()

    current.cache.set(
      new URL('assets/app.js', origin).href,
      '<html>fallback</html>',
    )
    expect((await current.inspect()).uiComplete).toBe(false)
    current.cache.clear()
    expect(await current.inspect()).toMatchObject({
      uiComplete: false,
      classifierComplete: false,
    })
  })

  it('requires authoritative classifier SHA even when a precache entry claims a different body', async () => {
    const current = fixture()
    const asset = current.resources.find((resource) =>
      resource.url.endsWith('file-0'),
    )!

    asset.integrity = `sha256-${digest('wrong-package', 'base64')}`
    current.cache.set(new URL(asset.url, origin).href, 'wrong-package')
    expect((await current.inspect()).classifierComplete).toBe(false)
  })

  it('repairs only invalid static assets with fresh integrity-checked network requests', async () => {
    const current = fixture()

    current.cache.delete(new URL('assets/worker.js', origin).href)
    current.cache.set(
      new URL(current.classifier[2].url, origin).href,
      'corrupt',
    )

    const requests: Request[] = []

    await repairResources({
      resources: (await current.inspect()).invalid,
      origin,

      async fetch(request) {
        requests.push(request)

        const path = request.url.slice(origin.length)

        return new Response(current.bodies.get(path))
      },

      async write(url, response) {
        current.cache.set(url, await response.text())
      },
    })

    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.cache === 'reload')).toBe(true)
    expect(
      requests.every((request) => request.integrity.startsWith('sha256-')),
    ).toBe(true)
    expect(await current.inspect()).toMatchObject({
      uiComplete: true,
      classifierComplete: true,
    })
  })

  it('preserves valid resources after failed preparation and repairs after reconnect', async () => {
    const current = fixture()
    const missing = new URL(current.classifier[4].url, origin).href

    current.cache.delete(missing)

    const before = new Map(current.cache)
    const repair = (online: boolean) =>
      repairResources({
        resources: [
          current.resources.find(
            (asset) => new URL(asset.url, origin).href === missing,
          )!,
        ],
        origin,

        async fetch(request) {
          if (!online) {
            throw new Error('offline')
          }

          return new Response(
            current.bodies.get(request.url.slice(origin.length)),
          )
        },

        async write(url, response) {
          current.cache.set(url, await response.text())
        },
      })

    await expect(repair(false)).rejects.toThrow('offline')

    expect(current.cache).toEqual(before)
    expect((await current.inspect()).classifierComplete).toBe(false)

    await repair(true)

    expect((await current.inspect()).classifierComplete).toBe(true)
  })

  it('never stores a mismatched fallback response or a foreign resource', async () => {
    const current = fixture()
    let writes = 0
    const repair = (resource: PrecacheResource) =>
      repairResources({
        resources: [resource],
        origin,

        async fetch() {
          return new Response('<html>server fallback</html>')
        },

        async write() {
          writes++
        },
      })

    await expect(repair(current.resources[0])).rejects.toThrow('versión')
    await expect(
      repair({ ...current.resources[0], url: 'https://foreign.example/a' }),
    ).rejects.toThrow('válido')

    expect(writes).toBe(0)
  })
})
