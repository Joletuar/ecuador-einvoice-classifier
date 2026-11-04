import { SelectionMode } from './classificationModel'
import type { Category } from './categoryModel'
import type {
  ConceptPrediction,
  ExactAmount,
  InvoiceIssue,
  RuleResult,
} from './classificationModel'

export interface Concept {
  id: string
  name: string | null
  cents: number | null
  original: Category
  category: Category
  selectionMode: typeof SelectionMode.Model | typeof SelectionMode.Manual
  descriptionPresent: boolean
  netAmount: ExactAmount
  prediction: ConceptPrediction
}

export interface Invoice {
  id: string
  issuer: string | null
  issuerRuc?: string | null
  buyerName?: string | null
  buyerIdentification?: string | null
  number: string | null
  date: string | null
  principal: Category
  originalPrincipal: Category
  principalMode: typeof SelectionMode.Automatic | typeof SelectionMode.Manual
  total: number | null
  concepts: Concept[]
  revision: number
  importId: string
  entryIndex: number
  entryPath: string | null
  sourceName: string
  modelPackageId: string
  currency: {
    raw: string | null
    code: 'USD' | null
  }
  dateRaw: string | null
  totalAmount: ExactAmount
  issues: InvoiceIssue[]
  automatic: RuleResult
  initial: RuleResult
}
