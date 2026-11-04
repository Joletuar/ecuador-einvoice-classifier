export const FileResultStatus = {
  Added: 'added',
  Duplicate: 'duplicate',
  Error: 'error',
} as const

export type FileResultStatus =
  (typeof FileResultStatus)[keyof typeof FileResultStatus]

export const ProcessingOutcomeKind = {
  Unavailable: 'unavailable',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const

export type ProcessingOutcomeKind =
  (typeof ProcessingOutcomeKind)[keyof typeof ProcessingOutcomeKind]

export const PreparationKind = {
  Loading: 'loading',
  Ready: 'ready',
  Error: 'error',
} as const

export const ProcessingErrorCode = {
  Unresolved: 'unresolved',
} as const

export type ProcessingErrorCode =
  (typeof ProcessingErrorCode)[keyof typeof ProcessingErrorCode]

export type PreparationKind =
  (typeof PreparationKind)[keyof typeof PreparationKind]
