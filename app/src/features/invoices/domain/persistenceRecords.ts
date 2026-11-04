import type {
  ConceptRecord,
  ExactAmount,
  InvoiceClassification,
  InvoiceIssue,
  ModelClasses,
} from './classificationModel'

export const InvoiceStoreName = {
  Imports: 'imports',
  Invoices: 'invoices',
  ModelPackages: 'modelPackages',
} as const

export type InvoiceStoreName =
  (typeof InvoiceStoreName)[keyof typeof InvoiceStoreName]

export const InvoiceIndexName = {
  ByName: 'byName',
  ByImport: 'byImport',
  ByImportEntry: 'byImportEntry',
  ByModelPackage: 'byModelPackage',
} as const

export type InvoiceIndexName =
  (typeof InvoiceIndexName)[keyof typeof InvoiceIndexName]

export const SourceKind = {
  Xml: 'xml',
  Zip: 'zip',
} as const

export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind]

export interface ImportRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly kind: typeof SourceKind.Xml | typeof SourceKind.Zip
  readonly originalBytes: number
  readonly createdAt: string
}

export interface InvoiceRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly importId: string
  readonly entryIndex: number
  readonly entryPath: string | null
  readonly modelPackageId: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly issuer: {
    readonly legalName: string | null
    readonly tradeName: string | null
    readonly ruc?: string | null
  }
  readonly buyer?: {
    readonly name: string | null
    readonly identification: string | null
  }
  readonly number: {
    readonly establishment: string | null
    readonly pointOfIssue: string | null
    readonly sequential: string | null
  }
  readonly date:
    | {
        readonly raw: string
        readonly iso: string | null
      }
    | {
        readonly raw: null
        readonly iso: null
      }
  readonly currency:
    | {
        readonly raw: string
        readonly code: 'USD' | null
      }
    | {
        readonly raw: null
        readonly code: null
      }
  readonly total: ExactAmount
  readonly concepts: readonly [ConceptRecord, ...ConceptRecord[]]
  readonly classification: InvoiceClassification
  readonly issues: readonly InvoiceIssue[]
}

export interface ModelPackageRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly modelFile: string
  readonly modelSha256: string
  readonly sourceModelSha256: string
  readonly runtimeSignature: string
  readonly ortVersion: string
  readonly unicodeVersion: string
  readonly featureCount: number
  readonly classes: ModelClasses
}

export interface LocalPersistenceSnapshot {
  readonly imports: readonly ImportRecord[]
  readonly invoices: readonly InvoiceRecord[]
  readonly modelPackages: readonly ModelPackageRecord[]
}
