import { WorkerErrorCode, WorkerStage } from './workerProtocol'
import { SelectionMode } from '../features/invoices/domain/classificationModel'
import type {
  CategoryIndex,
  ConceptRecord,
  SevenProbabilities,
} from '../features/invoices/domain/classificationModel'
import type { ModelPackageRecord } from '../features/invoices/domain/persistenceRecords'
import type { ExtractedConcept } from './xmlInvoiceReader'
import type { ModelAsset } from './workerProtocol'
import {
  checkpoint,
  failure,
  ProcessingCancelled,
  ProcessingFailure,
  type WorkControl,
} from './processingLimits'

export interface OrtTensor {
  readonly data: ArrayLike<string | number | bigint>
  readonly dims: readonly number[]
  dispose(): void
}

export interface OrtSession {
  run(inputs: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}

export interface OrtModule {
  env: {
    wasm: {
      numThreads: number
      proxy: boolean
      wasmPaths: {
        mjs: string
        wasm: string
      }
    }
  }
  Tensor: new (
    type: string,
    data: string[] | Uint8Array,
    dims: number[],
  ) => OrtTensor
  InferenceSession: {
    create(
      url: string,
      options: { executionProviders: string[] },
    ): Promise<OrtSession>
  }
}

export class ConceptClassificationFailure extends ProcessingFailure {
  constructor(readonly concepts: readonly ConceptRecord[]) {
    super({
      code: WorkerErrorCode.ModelFailed,
      stage: WorkerStage.Model,
      message: 'No se pudo completar la clasificación de conceptos.',
      retryable: true,
    })
  }
}

export async function verifyModelAssets(assets: readonly ModelAsset[]) {
  const expected = [
    'manifest.json',
    'concept_pipeline.onnx',
    'runtime/runtime.json',
    'runtime/ort.wasm.min.mjs',
    'runtime/ort-wasm-simd.mjs',
    'runtime/ort-wasm-simd.wasm',
    'runtime/LICENSE.onnxruntime',
    'runtime/ThirdPartyNotices.onnxruntime.txt',
    'runtime/LICENSE.utf8proc.md',
  ]

  if (
    assets.length !== expected.length ||
    new Set(assets.map((asset) => asset.path)).size !== expected.length ||
    expected.some((path) => !assets.some((asset) => asset.path === path))
  ) {
    throw failure(
      WorkerErrorCode.ModelUnavailable,
      WorkerStage.Model,
      'El inventario del modelo está incompleto.',
      true,
    )
  }

  for (const asset of assets) {
    const response = await fetch(asset.url)

    if (!response.ok) {
      throw failure(
        WorkerErrorCode.ModelUnavailable,
        WorkerStage.Model,
        'No se pudo descargar el paquete del modelo.',
        true,
      )
    }

    const hash = await crypto.subtle.digest(
      'SHA-256',
      await response.arrayBuffer(),
    )

    const hex = Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')

    if (hex !== asset.sha256) {
      throw failure(
        WorkerErrorCode.ModelUnavailable,
        WorkerStage.Model,
        'Un recurso del modelo no supera la comprobación de integridad.',
        true,
      )
    }
  }
}

export function createOnnxConceptClassifier(
  loadRuntime: (url: string) => Promise<OrtModule> = async (url) =>
    (await import(/* @vite-ignore */ url)) as OrtModule,
) {
  let runtime: OrtModule | null = null
  let session: OrtSession | null = null
  let model: ModelPackageRecord | null = null
  let preparing: Promise<void> | null = null

  async function dispose() {
    if (preparing) {
      await preparing.catch(() => undefined)
    }

    await session?.release()

    session = null
    runtime = null
    model = null
  }

  async function prepare(
    pack: ModelPackageRecord,
    assets: readonly ModelAsset[],
  ) {
    if (preparing) {
      await preparing
    }

    if (session && model?.id === pack.id) {
      return
    }

    preparing = (async () => {
      await session?.release()

      session = null
      model = null

      await verifyModelAssets(assets)

      const url = (path: string) => {
        const value = assets.find((asset) => asset.path === path)?.url

        if (!value || !/^https?:\/\//.test(value)) {
          throw failure(
            WorkerErrorCode.ModelUnavailable,
            SelectionMode.Model,
            'Las rutas del modelo deben ser absolutas.',
            true,
          )
        }

        return value
      }

      runtime = await loadRuntime(url('runtime/ort.wasm.min.mjs'))

      runtime.env.wasm.numThreads = 1
      runtime.env.wasm.proxy = false
      runtime.env.wasm.wasmPaths = {
        mjs: url('runtime/ort-wasm-simd.mjs'),
        wasm: url('runtime/ort-wasm-simd.wasm'),
      }

      session = await runtime.InferenceSession.create(url(pack.modelFile), {
        executionProviders: ['wasm'],
      })

      model = pack
    })()

    try {
      await preparing
    } finally {
      preparing = null
    }
  }

  async function classify(
    concepts: readonly ExtractedConcept[],
    batchSize: number,
    control: WorkControl,
  ): Promise<ConceptRecord[]> {
    const engine = runtime
    const activeSession = session
    const pack = model

    if (!engine || !activeSession || !pack) {
      throw failure(
        WorkerErrorCode.ModelUnavailable,
        WorkerStage.Model,
        'El modelo aún no está preparado.',
        true,
      )
    }

    const records: ConceptRecord[] = []

    try {
      for (let offset = 0; offset < concepts.length; offset += batchSize) {
        await checkpoint(control)

        const batch = concepts.slice(offset, offset + batchSize)
        const descriptions = new engine.Tensor(
          'string',
          batch.map((concept) => concept.description ?? ''),
          [batch.length],
        )
        const present = new engine.Tensor(
          'bool',
          Uint8Array.from(batch, (concept) =>
            Number(concept.descriptionPresent),
          ),
          [batch.length],
        )
        let outputs: Record<string, OrtTensor> = {}

        try {
          outputs = await activeSession.run({
            descriptions,
            description_present: present,
          })

          const {
            categories,
            category_indices: indices,
            probabilities,
            concept_statuses: statuses,
          } = outputs

          if (
            !categories ||
            !indices ||
            !probabilities ||
            !statuses ||
            categories.data.length !== batch.length ||
            indices.data.length !== batch.length ||
            statuses.data.length !== batch.length ||
            probabilities.dims.length !== 2 ||
            probabilities.dims[0] !== batch.length ||
            probabilities.dims[1] !== 7 ||
            probabilities.data.length !== batch.length * 7
          ) {
            throw new Error('Incompatible model output.')
          }

          for (let index = 0; index < batch.length; index++) {
            const source = batch[index]
            const status = Number(statuses.data[index])
            const categoryIndex = Number(indices.data[index])
            const row = Array.from({ length: 7 }, (_, column) =>
              Number(probabilities.data[index * 7 + column]),
            )

            if (
              row.some(
                (value) => !Number.isFinite(value) || value < 0 || value > 1,
              )
            ) {
              throw new Error('Invalid probabilities.')
            }

            const base = {
              id: source.id,
              position: source.position,
              netAmount: source.netAmount,
              selection: { mode: SelectionMode.Model },
            }

            if (
              status === 0 &&
              source.descriptionPresent &&
              Number.isInteger(categoryIndex) &&
              categoryIndex >= 0 &&
              categoryIndex < 7 &&
              categories.data[index] === pack.classes[categoryIndex]
            ) {
              records.push({
                ...base,
                descriptionPresent: true,
                description: source.description!,
                prediction: {
                  status: 0,
                  categoryIndex: categoryIndex as CategoryIndex,
                  probabilities: row as unknown as SevenProbabilities,
                },
              })
            } else if (
              ((status === 1 && !source.descriptionPresent) ||
                (status === 2 && source.descriptionPresent)) &&
              categoryIndex === -1 &&
              categories.data[index] === '' &&
              row.every((value) => value === 0)
            ) {
              const probabilities = [0, 0, 0, 0, 0, 0, 0] as const

              records.push(
                status === 1
                  ? {
                      ...base,
                      descriptionPresent: false,
                      description: null,
                      prediction: {
                        status: 1,
                        categoryIndex: -1,
                        probabilities,
                      },
                    }
                  : {
                      ...base,
                      descriptionPresent: true,
                      description: source.description!,
                      prediction: {
                        status: 2,
                        categoryIndex: -1,
                        probabilities,
                      },
                    },
              )
            } else {
              throw new Error('Inconsistent model outputs.')
            }
          }
        } finally {
          descriptions.dispose()
          present.dispose()

          for (const output of Object.values(outputs)) {
            output.dispose()
          }
        }
      }

      return records
    } catch (error) {
      if (error instanceof ProcessingCancelled) {
        throw error
      }

      throw new ConceptClassificationFailure(records)
    }
  }

  return { prepare, classify, dispose, currentPackage: () => model }
}
