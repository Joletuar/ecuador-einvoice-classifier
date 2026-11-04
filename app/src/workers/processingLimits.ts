import { WorkerErrorCode, WorkerStage } from './workerProtocol'
import type { WorkerError } from './workerProtocol'

export interface ProcessingLimits {
  readonly maxInputBytes: number
  readonly maxXmlBytes: number
  readonly maxExpandedBytes: number
  readonly maxZipEntries: number
  readonly chunkBytes: number
  readonly batchSize: number
}

export class ProcessingFailure extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message)
  }
}

export class ProcessingCancelled extends Error {}

export interface WorkControl {
  cancelled(): boolean
  yield(): Promise<void>
}

export const defaultWorkControl: WorkControl = {
  cancelled: () => false,

  yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
}

export function checkCancellation(control: WorkControl) {
  if (control.cancelled()) {
    throw new ProcessingCancelled()
  }
}

export async function checkpoint(control: WorkControl) {
  checkCancellation(control)
  await control.yield()
  checkCancellation(control)
}

export function failure(
  code: WorkerError['code'],
  stage: WorkerError['stage'],
  message: string,
  retryable = false,
): ProcessingFailure {
  return new ProcessingFailure({ code, stage, message, retryable })
}

export function validateLimits(limits: ProcessingLimits) {
  const keys: readonly (keyof ProcessingLimits)[] = [
    'maxInputBytes',
    'maxXmlBytes',
    'maxExpandedBytes',
    'maxZipEntries',
    'chunkBytes',
    'batchSize',
  ]

  if (
    !limits ||
    keys.some(
      (key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0,
    ) ||
    limits.chunkBytes < 4 ||
    limits.chunkBytes > 65_536 ||
    limits.batchSize > 64
  ) {
    throw failure(
      WorkerErrorCode.LimitExceeded,
      WorkerStage.Read,
      'Los límites de procesamiento no son válidos.',
    )
  }
}

export async function* blobChunks(
  blob: Blob,
  limits: ProcessingLimits,
  control: WorkControl,
) {
  if (blob.size > limits.maxInputBytes) {
    throw failure(
      WorkerErrorCode.LimitExceeded,
      WorkerStage.Read,
      'El archivo supera el límite de lectura.',
    )
  }

  for (let offset = 0; offset < blob.size; offset += limits.chunkBytes) {
    await checkpoint(control)
    yield new Uint8Array(
      await blob.slice(offset, offset + limits.chunkBytes).arrayBuffer(),
    )
  }
}
