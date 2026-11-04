import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createOnnxConceptClassifier,
  ConceptClassificationFailure,
  type OrtModule,
  type OrtTensor,
} from '../src/workers/onnxConceptClassifier'
import { readClassifierPackage } from '../build/classifierAssets'
import { immediateControl } from './fixtures/workerFixtures'

afterEach(() => vi.unstubAllGlobals())

describe('custom ONNX adapter', () => {
  function setup() {
    const pack = readClassifierPackage()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname.slice(1)

        return new Response(pack.bytes.get(path))
      }),
    )

    const tensors: OrtTensor[] = []
    const tensor = (data: OrtTensor['data'], dims: number[]): OrtTensor => {
      const value = { data, dims, dispose: vi.fn() }

      tensors.push(value)

      return value
    }
    const run = vi.fn(async (inputs: Record<string, OrtTensor>) => {
      expect(inputs.descriptions.data[0]).toBe('  ARROZ  ')
      expect(inputs.description_present.data[0]).toBe(1)

      return {
        categories: tensor(['Alimentación'], [1]),
        category_indices: tensor([0n], [1]),
        probabilities: tensor(
          [0.7, 0.1, 0.05, 0.05, 0.05, 0.025, 0.025],
          [1, 7],
        ),
        concept_statuses: tensor([0n], [1]),
      }
    })
    const release = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ run, release }))
    const runtime: OrtModule = {
      env: {
        wasm: { numThreads: 8, proxy: true, wasmPaths: { mjs: '', wasm: '' } },
      },
      Tensor: class {
        data
        dims
        dispose = vi.fn()
        constructor(
          _type: string,
          data: string[] | Uint8Array,
          dims: number[],
        ) {
          this.data = data
          this.dims = dims
          tensors.push(this)
        }
      },
      InferenceSession: { create },
    }
    const load = vi.fn(async () => runtime)
    const classifier = createOnnxConceptClassifier(load)
    const assets = pack.inventory.map((asset) => ({
      ...asset,
      url: `http://localhost/${asset.path}`,
    }))

    return {
      pack,
      classifier,
      assets,
      tensors,
      runtime,
      create,
      run,
      release,
      load,
    }
  }

  const concepts = [
    {
      id: 'c',
      position: 0,
      descriptionPresent: true,
      description: '  ARROZ  ',
      netAmount: { raw: '1', decimal: '1' },
    },
  ]

  it('uses original strings, one reusable single-thread session, double probabilities and disposal', async () => {
    const test = setup()

    await test.classifier.prepare(test.pack.modelPackage, test.assets)
    await test.classifier.prepare(test.pack.modelPackage, test.assets)

    const result = await test.classifier.classify(concepts, 1, immediateControl)

    expect(result[0].prediction).toMatchObject({
      status: 0,
      categoryIndex: 0,
      probabilities: [0.7, 0.1, 0.05, 0.05, 0.05, 0.025, 0.025],
    })
    expect(test.runtime.env.wasm).toMatchObject({
      numThreads: 1,
      proxy: false,
    })
    expect(test.create).toHaveBeenCalledTimes(1)
    expect(
      test.tensors.every(
        (tensor) => vi.mocked(tensor.dispose).mock.calls.length === 1,
      ),
    ).toBe(true)

    await test.classifier.dispose()

    expect(test.release).toHaveBeenCalledTimes(1)
  })

  it('does not fabricate failed predictions when an engine call fails', async () => {
    const test = setup()

    await test.classifier.prepare(test.pack.modelPackage, test.assets)

    test.run.mockRejectedValueOnce(new Error('engine'))

    await expect(
      test.classifier.classify(concepts, 1, immediateControl),
    ).rejects.toBeInstanceOf(ConceptClassificationFailure)

    expect(
      test.tensors.every(
        (tensor) => vi.mocked(tensor.dispose).mock.calls.length === 1,
      ),
    ).toBe(true)

    await test.classifier.dispose()
  })

  it('rejects an incomplete inventory or a corrupt resource before importing the runtime', async () => {
    const test = setup()

    await expect(
      test.classifier.prepare(test.pack.modelPackage, test.assets.slice(1)),
    ).rejects.toHaveProperty('detail.code', 'MODEL_UNAVAILABLE')

    const wrong = test.assets.map((asset, index) =>
      index === 0
        ? {
            ...asset,
            sha256: createHash('sha256').update('wrong').digest('hex'),
          }
        : asset,
    )

    await expect(
      test.classifier.prepare(test.pack.modelPackage, wrong),
    ).rejects.toHaveProperty('detail.code', 'MODEL_UNAVAILABLE')

    expect(test.load).not.toHaveBeenCalled()
  })
})
