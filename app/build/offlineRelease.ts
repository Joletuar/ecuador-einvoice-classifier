import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import type { ResolvedVitePWAOptions } from 'vite-plugin-pwa'
import { readClassifierPackage } from './classifierAssets'

const applicationRoot = fileURLToPath(new URL('../', import.meta.url))

export function readOfflineRelease(
  root = applicationRoot,
  configuration: unknown = {},
) {
  const pack = readClassifierPackage()
  const sourceFiles: string[] = []

  function collect(directory: string) {
    for (const entry of readdirSync(resolve(root, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`

      if (entry.isDirectory()) {
        collect(path)
      } else {
        sourceFiles.push(path)
      }
    }
  }

  collect('src')
  collect('build')
  sourceFiles.push('index.html', 'vite.config.ts', 'package.json', 'bun.lock')

  const digest = createHash('sha256')
    .update(pack.modelPackage.id)
    .update(JSON.stringify(configuration))

  for (const path of sourceFiles.sort()) {
    digest
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(root, path)))
  }

  return {
    identity: {
      appReleaseId: digest.digest('hex'),
      modelPackageId: pack.modelPackage.id,
    },
    inventory: pack.inventory,
  }
}

export function offlineReleasePlugin(
  release: ReturnType<typeof readOfflineRelease>,
): Plugin {
  const virtual = 'virtual:app-release'
  let base = '/'

  return {
    name: 'offline-release',

    configResolved(config) {
      base = config.base
    },

    resolveId(id) {
      return id === virtual ? `\0${virtual}` : null
    },

    load(id) {
      if (id !== `\0${virtual}`) {
        return
      }

      const assets = release.inventory.map((entry) => ({
        ...entry,
        url: `${base}classifier/${release.identity.modelPackageId}/${entry.path}`,
      }))

      return `export const appRelease = ${JSON.stringify(release.identity)}
export const classifierAssets = ${JSON.stringify(assets)}`
    },
  }
}

export function precacheIntegrity() {
  let directory = resolve(applicationRoot, 'dist')
  const plugin: Plugin = {
    name: 'precache-integrity',

    configResolved(config) {
      directory = resolve(config.root, config.build.outDir)
    },
  }

  const withIntegrity = <Entry extends { url: string }>(entry: Entry) => ({
    ...entry,
    integrity: `sha256-${createHash('sha256')
      .update(readFileSync(resolve(directory, entry.url)))
      .digest('base64')}`,
  })

  const transform = (
    entries: {
      url: string
      revision: string | null
      size: number
    }[],
  ) => ({
    manifest: entries.map(withIntegrity),
    warnings: [],
  })

  const beforeBuildServiceWorker = (options: ResolvedVitePWAOptions) => {
    // Workbox appends these after manifestTransforms, including the PWA icons
    // and generated web manifest. Hash them once those files have been emitted.
    options.injectManifest.additionalManifestEntries =
      options.injectManifest.additionalManifestEntries?.map((entry) =>
        withIntegrity(
          typeof entry === 'string' ? { url: entry, revision: null } : entry,
        ),
      )
  }

  return { plugin, transform, beforeBuildServiceWorker }
}
