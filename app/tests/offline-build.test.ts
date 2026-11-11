import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { readClassifierPackage } from '../build/classifierAssets'
import {
  inspectResources,
  type PrecacheResource,
} from '../src/features/offline/services/offlineResources'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

it('builds a complete verifiable precache with a limited file descriptor budget', async () => {
  vi.stubEnv('VITE_STORAGE_MAX_FILES', '5000')
  vi.stubEnv('VITE_STORAGE_MAX_BYTES', '1073741824')

  const directory = await mkdtemp(join(tmpdir(), 'einvoice-offline-build-'))

  directories.push(directory)

  const arguments_ = [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    directory,
    '--logLevel',
    'error',
  ]

  if (process.platform === 'win32') {
    await run(process.execPath, arguments_, { cwd: root })
  } else {
    await run(
      'sh',
      [
        '-c',
        'ulimit -n 256 && exec "$@"',
        'offline-build',
        process.execPath,
        ...arguments_,
      ],
      { cwd: root },
    )
  }

  // Workbox injects this JSON after compiling the service worker.
  const source = await readFile(resolve(directory, 'sw.js'), 'utf8')
  const marker = source.lastIndexOf('manifest.webmanifest')

  expect(marker).toBeGreaterThan(0)

  const resources: PrecacheResource[] = JSON.parse(
    source.slice(
      source.lastIndexOf('[', marker),
      source.indexOf(']', marker) + 1,
    ),
  )

  expect(resources.map((entry) => entry.url)).toEqual(
    expect.arrayContaining([
      'manifest.webmanifest',
      'pwa-192x192.png',
      'pwa-512x512.png',
    ]),
  )
  expect(
    resources.filter((entry) => !entry.integrity).map((entry) => entry.url),
  ).toEqual([])

  const pack = readClassifierPackage()
  const origin = 'https://offline-build.test/'
  const inspection = await inspectResources({
    resources,
    classifier: pack.inventory.map((entry) => ({
      url: `classifier/${pack.modelPackage.id}/${entry.path}`,
      sha256: entry.sha256,
    })),
    origin,
    async read(url) {
      const bytes = await readFile(
        resolve(directory, new URL(url).pathname.slice(1)),
      )

      return new Response(new Uint8Array(bytes))
    },
  })

  expect(inspection).toEqual({
    uiComplete: true,
    classifierComplete: true,
    invalid: [],
  })
}, 30_000)
