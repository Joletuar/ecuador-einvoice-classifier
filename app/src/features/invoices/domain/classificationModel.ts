export const SelectionMode = {
  Model: 'model',
  Manual: 'manual',
  Automatic: 'automatic',
} as const

export type SelectionMode = (typeof SelectionMode)[keyof typeof SelectionMode]

export const RuleStatus = {
  Resolved: 'resolved',
  Provisional: 'provisional',
  Unassigned: 'unassigned',
} as const

export type RuleStatus = (typeof RuleStatus)[keyof typeof RuleStatus]

export const RuleCriterion = {
  ConceptCount: 'concept_count',
  NetAmount: 'net_amount',
  FirstOccurrence: 'first_occurrence',
} as const

export type RuleCriterion = (typeof RuleCriterion)[keyof typeof RuleCriterion]

export const RuleReason = {
  NoClassifiedConcepts: 'NO_CLASSIFIED_CONCEPTS',
  UnavailableTieAmount: 'UNAVAILABLE_TIE_AMOUNT',
} as const

export type RuleReason = (typeof RuleReason)[keyof typeof RuleReason]

export const InvoiceIssueCode = {
  MissingField: 'MISSING_FIELD',
  InvalidField: 'INVALID_FIELD',
  InvalidAmount: 'INVALID_AMOUNT',
  UnrepresentableCents: 'UNREPRESENTABLE_CENTS',
  MissingCurrency: 'MISSING_CURRENCY',
  UnknownCurrency: 'UNKNOWN_CURRENCY',
  MissingDescription: 'MISSING_DESCRIPTION',
  InvalidUnicode: 'INVALID_UNICODE',
  UnresolvedInvoiceCategory: 'UNRESOLVED_INVOICE_CATEGORY',
} as const

export type InvoiceIssueCode =
  (typeof InvoiceIssueCode)[keyof typeof InvoiceIssueCode]

export const InvoiceIssueStage = {
  Extract: 'extract',
  Model: 'model',
  InvoiceRules: 'invoice_rules',
  Presentation: 'presentation',
} as const

export type InvoiceIssueStage =
  (typeof InvoiceIssueStage)[keyof typeof InvoiceIssueStage]

export const CanonicalCategory = {
  Food: 'Alimentación',
  EducationArtsCulture: 'Educación, Arte y Cultura',
  Other: 'Otros',
  Health: 'Salud',
  NationalTourism: 'Turismo Nacional',
  Clothing: 'Vestimenta',
  Housing: 'Vivienda',
} as const

export const canonicalCategories = [
  CanonicalCategory.Food,
  CanonicalCategory.EducationArtsCulture,
  CanonicalCategory.Other,
  CanonicalCategory.Health,
  CanonicalCategory.NationalTourism,
  CanonicalCategory.Clothing,
  CanonicalCategory.Housing,
] as const

export type CanonicalCategory = (typeof canonicalCategories)[number]

export type CategoryIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

// El orden guardado debe ser el del modelo porque cada índice identifica una
// categoría concreta.
export type ModelClasses = readonly [
  CanonicalCategory,
  CanonicalCategory,
  CanonicalCategory,
  CanonicalCategory,
  CanonicalCategory,
  CanonicalCategory,
  CanonicalCategory,
]

export type SevenProbabilities = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export interface SuccessfulPrediction {
  readonly status: 0
  readonly categoryIndex: CategoryIndex
  readonly probabilities: SevenProbabilities
}

export interface FailedPrediction {
  readonly status: 1 | 2
  readonly categoryIndex: -1
  readonly probabilities: readonly [0, 0, 0, 0, 0, 0, 0]
}

export type ConceptPrediction = SuccessfulPrediction | FailedPrediction

export type ConceptSelection =
  | { readonly mode: typeof SelectionMode.Model }
  | {
      readonly mode: typeof SelectionMode.Manual
      readonly category: CanonicalCategory | null
    }

export type InvoiceSelection =
  | { readonly mode: typeof SelectionMode.Automatic }
  | {
      readonly mode: typeof SelectionMode.Manual
      readonly category: CanonicalCategory | null
    }

export type ExactAmount =
  | {
      readonly raw: string
      readonly decimal: string | null
    }
  | {
      readonly raw: null
      readonly decimal: null
    }

interface ConceptFields {
  readonly id: string
  readonly position: number
  readonly netAmount: ExactAmount
  readonly selection: ConceptSelection
}

export type ConceptRecord = ConceptFields &
  (
    | {
        readonly descriptionPresent: false
        readonly description: null
        readonly prediction: FailedPrediction & { readonly status: 1 }
      }
    | {
        readonly descriptionPresent: true
        readonly description: string
        readonly prediction:
          SuccessfulPrediction | (FailedPrediction & { readonly status: 2 })
      }
  )

export const invoiceRulesVersion = 'DN-0001@2026-11-03' as const

export interface AssignedRuleResult {
  readonly rulesVersion: typeof invoiceRulesVersion
  readonly status: typeof RuleStatus.Resolved | typeof RuleStatus.Provisional
  readonly category: CanonicalCategory
  readonly criterion:
    | typeof RuleCriterion.ConceptCount
    | typeof RuleCriterion.NetAmount
    | typeof RuleCriterion.FirstOccurrence
  readonly reason: null
}

export interface UnassignedRuleResult {
  readonly rulesVersion: typeof invoiceRulesVersion
  readonly status: typeof RuleStatus.Unassigned
  readonly category: null
  readonly criterion: null
  readonly reason:
    | typeof RuleReason.NoClassifiedConcepts
    | typeof RuleReason.UnavailableTieAmount
}

export type RuleResult = AssignedRuleResult | UnassignedRuleResult

export interface InvoiceClassification {
  readonly initial: RuleResult
  readonly automatic: RuleResult
  readonly selection: InvoiceSelection
}

export interface InvoiceIssue {
  readonly code:
    | typeof InvoiceIssueCode.MissingField
    | typeof InvoiceIssueCode.InvalidField
    | typeof InvoiceIssueCode.InvalidAmount
    | typeof InvoiceIssueCode.UnrepresentableCents
    | typeof InvoiceIssueCode.MissingCurrency
    | typeof InvoiceIssueCode.UnknownCurrency
    | typeof InvoiceIssueCode.MissingDescription
    | typeof InvoiceIssueCode.InvalidUnicode
    | typeof InvoiceIssueCode.UnresolvedInvoiceCategory
  readonly stage:
    | typeof InvoiceIssueStage.Extract
    | typeof InvoiceIssueStage.Model
    | typeof InvoiceIssueStage.InvoiceRules
    | typeof InvoiceIssueStage.Presentation
  readonly field: string
  readonly conceptId: string | null
}
