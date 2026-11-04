import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import {
  canonicalCategories,
  type ModelClasses,
} from '../src/features/invoices/domain/classificationModel'
import type { ModelPackageRecord } from '../src/features/invoices/domain/persistenceRecords'

const runtimeFiles = [
  'ort.wasm.min.mjs',
  'ort-wasm-simd.mjs',
  'ort-wasm-simd.wasm',
  'LICENSE.onnxruntime',
  'ThirdPartyNotices.onnxruntime.txt',
  'LICENSE.utf8proc.md',
]
const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')

interface RuntimeManifest {
  version: string
  signature: string
  unicode_version: string
  threads: number
  simd: boolean
  loader: string
  module: string
  wasm: string
  files: Record<string, string>
}

interface ExportManifest {
  model: string
  sha256: string
  source_sha256: string
  classes: ModelClasses
  features: number
  unicode_version: string
  runtime_signature: string
  runtime_packaged: boolean
  runtime: RuntimeManifest
}

export function readClassifierPackage(
  directory = fileURLToPath(
    new URL('../../ml/outputs/models/export/', import.meta.url),
  ),
) {
  const bytes = new Map<string, Uint8Array>()
  const read = (path: string) => {
    const value = readFileSync(resolve(directory, path))

    bytes.set(path, value)

    return value
  }

  const manifest = JSON.parse(
    read('manifest.json').toString(),
  ) as ExportManifest
  const runtime = JSON.parse(
    read('runtime/runtime.json').toString(),
  ) as RuntimeManifest

  if (
    manifest.model !== 'concept_pipeline.onnx' ||
    !manifest.runtime_packaged ||
    manifest.runtime_signature !== runtime.signature ||
    manifest.runtime.signature !== runtime.signature ||
    manifest.runtime.version !== runtime.version ||
    manifest.unicode_version !== runtime.unicode_version ||
    runtime.threads !== 1 ||
    runtime.simd !== true ||
    runtime.loader !== 'ort.wasm.min.mjs' ||
    runtime.module !== 'ort-wasm-simd.mjs' ||
    runtime.wasm !== 'ort-wasm-simd.wasm' ||
    !Number.isSafeInteger(manifest.features) ||
    manifest.features <= 0 ||
    manifest.classes.length !== 7 ||
    new Set(manifest.classes).size !== 7 ||
    manifest.classes.some((category) => !canonicalCategories.includes(category))
  ) {
    throw new Error('El paquete ONNX y su runtime no son compatibles.')
  }

  if (digest(read(manifest.model)) !== manifest.sha256) {
    throw new Error('Hash incorrecto del modelo ONNX.')
  }

  if (
    Object.keys(runtime.files).length !== runtimeFiles.length ||
    Object.keys(manifest.runtime.files).length !== runtimeFiles.length
  ) {
    throw new Error('Inventario incompleto del runtime.')
  }

  for (const name of runtimeFiles) {
    if (
      !/^[a-f0-9]{64}$/.test(runtime.files[name]) ||
      manifest.runtime.files[name] !== runtime.files[name] ||
      digest(read(`runtime/${name}`)) !== runtime.files[name]
    ) {
      throw new Error(`Hash incorrecto del runtime: ${name}`)
    }
  }

  const inventory = [...bytes]
    .map(([path, value]) => ({ path, sha256: digest(value) }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const id = digest(
    inventory.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(''),
  )

  const modelPackage: ModelPackageRecord = {
    schemaVersion: 1,
    id,
    modelFile: manifest.model,
    modelSha256: manifest.sha256,
    sourceModelSha256: manifest.source_sha256,
    runtimeSignature: runtime.signature,
    ortVersion: runtime.version,
    unicodeVersion: runtime.unicode_version,
    featureCount: manifest.features,
    classes: manifest.classes,
  }

  return { modelPackage, inventory, bytes }
}

export function classifierAssets(options: { directory?: string } = {}): Plugin {
  const pack = readClassifierPackage(options.directory)
  let base = '/'

  const virtual = 'virtual:classifier-package'
  const prefix = `classifier/${pack.modelPackage.id}/`

  return {
    name: 'classifier-assets',

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

      const assets = pack.inventory.map((entry) => ({
        ...entry,
        url: `${base}${prefix}${entry.path}`,
      }))

      const definition = JSON.stringify({
        modelPackage: pack.modelPackage,
        assets,
      })

      return `export const classifierPackage = ${definition}`
    },

    generateBundle() {
      for (const [path, source] of pack.bytes) {
        this.emitFile({ type: 'asset', fileName: prefix + path, source })
      }
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname
        const pathPrefix = `${base}${prefix}`

        if (!pathname.startsWith(pathPrefix)) {
          return next()
        }

        const name = pathname.slice(pathPrefix.length)
        const source = pack.bytes.get(name)

        if (!source) {
          response.statusCode = 404
          response.end()

          return
        }

        const mime = name.endsWith('.mjs')
          ? 'text/javascript'
          : name.endsWith('.wasm')
            ? 'application/wasm'
            : name.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream'

        response.setHeader('Content-Type', mime)
        response.setHeader('Cache-Control', 'public,max-age=31536000,immutable')
        response.end(source)
      })
    },
  }
}
