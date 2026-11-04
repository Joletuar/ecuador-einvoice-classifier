export const InvoiceSnapshotKind = {
  Unknown: 'unknown',
  Loading: 'loading',
  Ready: 'ready',
  Error: 'error',
} as const

export type InvoiceSnapshotKind =
  (typeof InvoiceSnapshotKind)[keyof typeof InvoiceSnapshotKind]
