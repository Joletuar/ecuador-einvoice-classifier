import type { ProcessingLimits } from '../../workers/processingLimits'

export const processingLimits: ProcessingLimits = Object.freeze({
  maxInputBytes: 32 * 1024 * 1024,
  maxXmlBytes: 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxZipEntries: 10_000,
  chunkBytes: 16 * 1024,
  batchSize: 64,
})
