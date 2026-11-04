import {
  canonicalCategories,
  type ConceptRecord,
} from '../../src/features/invoices/domain/classificationModel'
import type { ModelPackageRecord } from '../../src/features/invoices/domain/persistenceRecords'
import type { ProcessingLimits } from '../../src/workers/processingLimits'
import type { ExtractedConcept } from '../../src/workers/xmlInvoiceReader'
import type { WorkerSource } from '../../src/workers/workerProtocol'

export const limits: ProcessingLimits = {
  maxInputBytes: 1_000_000,
  maxXmlBytes: 200_000,
  maxExpandedBytes: 500_000,
  maxZipEntries: 50,
  chunkBytes: 128,
  batchSize: 2,
}

export const modelPackage: ModelPackageRecord = {
  schemaVersion: 1,
  id: 'synthetic-package',
  modelFile: 'concept_pipeline.onnx',
  modelSha256: 'a'.repeat(64),
  sourceModelSha256: 'b'.repeat(64),
  runtimeSignature: 'c'.repeat(64),
  ortVersion: '1.31.1',
  unicodeVersion: '16.0.0',
  featureCount: 26780,
  classes: canonicalCategories,
}

export const directXml = (
  details = '<detalle><descripcion>  ARROZ &amp; café  </descripcion><precioTotalSinImpuesto>10.00</precioTotalSinImpuesto></detalle>',
) =>
  `<factura><infoTributaria><claveAcceso>${'0'.repeat(48)}1</claveAcceso><razonSocial>Emisor ficticio</razonSocial><nombreComercial>Comercio</nombreComercial><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000123</secuencial></infoTributaria><infoFactura><fechaEmision>29/02/2024</fechaEmision><moneda>USD</moneda><importeTotal>11.50</importeTotal></infoFactura><detalles>${details}</detalles></factura>`

export async function* encoded(text: string, chunkBytes = 97) {
  const bytes = new TextEncoder().encode(text)

  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    yield bytes.subarray(offset, offset + chunkBytes)
  }
}

export const immediateControl = {
  cancelled: () => false,

  yield: async () => undefined,
}

export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []

  for await (const value of values) {
    result.push(value)
  }

  return result
}

export function source(file: File, kind: 'xml' | 'zip' = 'xml'): WorkerSource {
  return {
    selectionId: 'selection',
    source: {
      schemaVersion: 1,
      id: 'source',
      name: file.name,
      kind,
      originalBytes: file.size,
      createdAt: '2026-11-03T00:00:00Z',
    },
    file,
    entries: { mode: 'initial' },
  }
}

export function predictions(
  concepts: readonly ExtractedConcept[],
): ConceptRecord[] {
  return concepts.map((concept): ConceptRecord => {
    const base = {
      id: concept.id,
      position: concept.position,
      netAmount: concept.netAmount,
      selection: { mode: 'model' as const },
    }

    return concept.descriptionPresent
      ? {
          ...base,
          descriptionPresent: true,
          description: concept.description!,
          prediction: {
            status: 0,
            categoryIndex: 0,
            probabilities: [1, 0, 0, 0, 0, 0, 0],
          },
        }
      : {
          ...base,
          descriptionPresent: false,
          description: null,
          prediction: {
            status: 1,
            categoryIndex: -1,
            probabilities: [0, 0, 0, 0, 0, 0, 0],
          },
        }
  })
}
