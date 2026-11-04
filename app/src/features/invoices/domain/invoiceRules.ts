import {
  InvoiceIssueCode,
  InvoiceIssueStage,
  RuleCriterion,
  RuleReason,
  RuleStatus,
  SelectionMode,
  invoiceRulesVersion,
  type AssignedRuleResult,
  type CanonicalCategory,
  type ConceptRecord,
  type InvoiceClassification,
  type InvoiceIssue,
  type ModelClasses,
  type RuleResult,
  type UnassignedRuleResult,
} from './classificationModel'

export type InvoiceRuleConcept = Pick<
  ConceptRecord,
  'id' | 'position' | 'netAmount' | 'prediction' | 'selection'
>

export interface InvoiceRuleEvaluation {
  readonly result: RuleResult
  readonly issues: readonly InvoiceIssue[]
}

interface CategoryGroup {
  category: CanonicalCategory
  concepts: InvoiceRuleConcept[]
  firstPosition: number
}

interface DecimalValue {
  coefficient: bigint
  scale: number
}

export function effectiveConceptCategory(
  concept: Pick<InvoiceRuleConcept, 'prediction' | 'selection'>,
  classes: ModelClasses,
): CanonicalCategory | null {
  if (concept.selection.mode === SelectionMode.Manual) {
    return concept.selection.category
  }

  if (concept.prediction.status !== 0) {
    return null
  }

  return classes[concept.prediction.categoryIndex]
}

export function effectiveInvoiceCategory(
  classification: InvoiceClassification,
): CanonicalCategory | null {
  return classification.selection.mode === SelectionMode.Manual
    ? classification.selection.category
    : classification.automatic.category
}

function parseExactDecimal(value: string | null): DecimalValue | null {
  if (
    value === null ||
    value.trim() !== value ||
    !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  ) {
    return null
  }

  const [integer, fraction = ''] = value.split('.')

  return {
    coefficient: BigInt(integer + fraction),
    scale: fraction.length,
  }
}

function unassigned(
  reason: UnassignedRuleResult['reason'],
  issues: readonly InvoiceIssue[] = [],
): InvoiceRuleEvaluation {
  return {
    result: {
      rulesVersion: invoiceRulesVersion,
      status: RuleStatus.Unassigned,
      category: null,
      criterion: null,
      reason,
    },
    issues,
  }
}

export function classifyInvoice(
  concepts: readonly InvoiceRuleConcept[],
  classes: ModelClasses,
): InvoiceRuleEvaluation {
  const groups = new Map<CanonicalCategory, CategoryGroup>()
  let classifiedCount = 0

  for (const concept of concepts) {
    const category = effectiveConceptCategory(concept, classes)

    if (category === null) {
      continue
    }

    classifiedCount++

    const existing = groups.get(category)

    if (existing) {
      existing.concepts.push(concept)
      existing.firstPosition = Math.min(
        existing.firstPosition,
        concept.position,
      )
    } else {
      groups.set(category, {
        category,
        concepts: [concept],
        firstPosition: concept.position,
      })
    }
  }

  if (classifiedCount === 0) {
    return unassigned(RuleReason.NoClassifiedConcepts)
  }

  const status =
    classifiedCount === concepts.length
      ? RuleStatus.Resolved
      : RuleStatus.Provisional

  const largestCount = Math.max(
    ...Array.from(groups.values(), (group) => group.concepts.length),
  )
  let candidates = Array.from(groups.values()).filter(
    (group) => group.concepts.length === largestCount,
  )

  function assigned(
    group: CategoryGroup,
    criterion: AssignedRuleResult['criterion'],
  ): InvoiceRuleEvaluation {
    return {
      result: {
        rulesVersion: invoiceRulesVersion,
        status,
        category: group.category,
        criterion,
        reason: null,
      },
      issues: [],
    }
  }

  if (candidates.length === 1) {
    return assigned(candidates[0], RuleCriterion.ConceptCount)
  }

  const amounts = new Map<InvoiceRuleConcept, DecimalValue>()
  const issues: InvoiceIssue[] = []
  let largestScale = 0

  // Solo se necesitan los importes de las categorías empatadas. Un importe
  // ausente en otra categoría no debe impedir la decisión.
  for (const group of candidates) {
    for (const concept of group.concepts) {
      const amount = parseExactDecimal(concept.netAmount.decimal)

      if (amount === null) {
        issues.push({
          code:
            concept.netAmount.raw === null
              ? InvoiceIssueCode.MissingField
              : InvoiceIssueCode.InvalidAmount,
          stage: InvoiceIssueStage.InvoiceRules,
          field: `/concepts/${concept.position}/netAmount`,
          conceptId: concept.id,
        })
        continue
      }

      amounts.set(concept, amount)
      largestScale = Math.max(largestScale, amount.scale)
    }
  }

  if (issues.length > 0) {
    return unassigned(RuleReason.UnavailableTieAmount, issues)
  }

  const totals = new Map<CanonicalCategory, bigint>()

  for (const group of candidates) {
    let total = 0n

    for (const concept of group.concepts) {
      const amount = amounts.get(concept)!

      total += amount.coefficient * 10n ** BigInt(largestScale - amount.scale)
    }

    totals.set(group.category, total)
  }

  let largestTotal: bigint | null = null

  for (const total of totals.values()) {
    if (largestTotal === null || total > largestTotal) {
      largestTotal = total
    }
  }

  candidates = candidates.filter(
    (group) => totals.get(group.category) === largestTotal,
  )

  if (candidates.length === 1) {
    return assigned(candidates[0], RuleCriterion.NetAmount)
  }

  const first = candidates.reduce((earliest, group) =>
    group.firstPosition < earliest.firstPosition ? group : earliest,
  )

  return assigned(first, RuleCriterion.FirstOccurrence)
}
