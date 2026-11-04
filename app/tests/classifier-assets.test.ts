import { afterEach, describe, expect, it } from 'vitest'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { readClassifierPackage } from '../build/classifierAssets'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('classifier build resources', () => {
  it('covers all nine resources with a deterministic content identity and original bytes', () => {
    const first = readClassifierPackage()
    const second = readClassifierPackage()

    expect(first.inventory).toHaveLength(9)
    expect(first.modelPackage.id).toBe(second.modelPackage.id)
    expect(first.modelPackage.id).not.toBe(first.modelPackage.modelSha256)

    for (const [path, bytes] of first.bytes) {
      expect(
        Buffer.from(bytes).equals(
          readFileSync(
            fileURLToPath(
              new URL(
                `../../ml/outputs/models/export/${path}`,
                import.meta.url,
              ),
            ),
          ),
        ),
      ).toBe(true)
    }
  })

  it.each(['concept_pipeline.onnx', 'runtime/ort-wasm-simd.wasm'])(
    'rejects corrupted build inputs: %s',
    (name) => {
      const path = mkdtempSync(join(tmpdir(), 'classifier-assets-'))

      temporary.push(path)
      cpSync(
        fileURLToPath(
          new URL('../../ml/outputs/models/export/', import.meta.url),
        ),
        path,
        { recursive: true },
      )
      writeFileSync(join(path, name), 'corrupted')
      expect(() => readClassifierPackage(path)).toThrow(/Hash/)
    },
  )
})
