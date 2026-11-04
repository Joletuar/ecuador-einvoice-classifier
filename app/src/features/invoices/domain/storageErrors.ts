export const StorageErrorCode = {
  WriteFailed: 'storage-write-failed',
  Limit: 'storage-limit',
  InvalidPayload: 'invalid-payload',
  Unavailable: 'storage-unavailable',
  NotAvailable: 'unavailable',
  OpeningBlocked: 'storage-opening-blocked',
  Conflict: 'storage-conflict',
  InvoiceNotFound: 'invoice-not-found',
  ConceptNotFound: 'concept-not-found',
  RulesUnavailable: 'rules-unavailable',
  RulesFailed: 'rules-failed',
  SessionClosed: 'storage-session-closed',
  Busy: 'storage-busy',
  UpdateBlocked: 'update-blocked',
} as const

export type StorageErrorCode =
  (typeof StorageErrorCode)[keyof typeof StorageErrorCode]
