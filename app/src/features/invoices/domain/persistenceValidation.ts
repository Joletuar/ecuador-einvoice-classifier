import {
  InvoiceIssueCode,
  InvoiceIssueStage,
  RuleCriterion,
  RuleReason,
  RuleStatus,
  SelectionMode,
  canonicalCategories,
  invoiceRulesVersion,
  type CanonicalCategory,
  type ConceptPrediction,
  type ConceptRecord,
  type ConceptSelection,
  type ExactAmount,
  type InvoiceIssue,
  type InvoiceSelection,
  type RuleResult,
} from './classificationModel'
import { SourceKind } from './persistenceRecords'

import type {
  ImportRecord,
  InvoiceRecord,
  LocalPersistenceSnapshot,
  ModelPackageRecord,
} from './persistenceRecords'

type Plain = Record<string, unknown>

export function plain(value: unknown): value is Plain {
  if (!value || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

export function fields(
  value: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Plain {
  return (
    plain(value) &&
    Object.keys(value).length ===
      keys.length +
        optionalKeys.reduce(
          (count, key) => count + (Object.hasOwn(value, key) ? 1 : 0),
          0,
        ) &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false
  }

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      return false
    }
  }

  return true
}

const text = (value: unknown): value is string => typeof value === 'string'
const nonempty = (value: unknown): value is string =>
  text(value) && value.length > 0
const nullableText = (value: unknown) => value === null || text(value)
const nullableNonempty = (value: unknown) => value === null || nonempty(value)
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && Number(value) >= minimum
const hash = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value)

export function isCanonicalCategory(
  value: unknown,
): value is CanonicalCategory {
  return canonicalCategories.some((category) => category === value)
}

const nullableCategory = (value: unknown) =>
  value === null || isCanonicalCategory(value)

export function canonicalDate(value: unknown): value is string {
  return (
    text(value) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}

const timestamp = (value: unknown) =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  canonicalDate(value.slice(0, 10))

export function validateExactAmount(value: unknown): value is ExactAmount {
  return (
    fields(value, ['raw', 'decimal']) &&
    nullableText(value.raw) &&
    (value.decimal === null ||
      (text(value.decimal) &&
        /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.decimal))) &&
    (value.raw !== null || value.decimal === null)
  )
}

export function validateConceptSelection(
  value: unknown,
): value is ConceptSelection {
  return (
    (fields(value, ['mode']) && value.mode === SelectionMode.Model) ||
    (fields(value, ['mode', 'category']) &&
      value.mode === SelectionMode.Manual &&
      nullableCategory(value.category))
  )
}

export function validateInvoiceSelection(
  value: unknown,
): value is InvoiceSelection {
  return (
    (fields(value, ['mode']) && value.mode === SelectionMode.Automatic) ||
    (fields(value, ['mode', 'category']) &&
      value.mode === SelectionMode.Manual &&
      nullableCategory(value.category))
  )
}

export function validatePrediction(value: unknown): value is ConceptPrediction {
  if (
    !fields(value, ['status', 'categoryIndex', 'probabilities']) ||
    !denseArray(value.probabilities) ||
    value.probabilities.length !== 7 ||
    !value.probabilities.every(
      (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1,
    )
  ) {
    return false
  }

  if (value.status === 0) {
    return integer(value.categoryIndex) && Number(value.categoryIndex) <= 6
  }

  return (
    (value.status === 1 || value.status === 2) &&
    value.categoryIndex === -1 &&
    value.probabilities.every((p) => p === 0)
  )
}

export function validateRuleResult(value: unknown): value is RuleResult {
  if (
    !fields(value, [
      'rulesVersion',
      'status',
      'category',
      'criterion',
      'reason',
    ]) ||
    value.rulesVersion !== invoiceRulesVersion
  ) {
    return false
  }

  if (value.status === RuleStatus.Unassigned) {
    return (
      value.category === null &&
      value.criterion === null &&
      (value.reason === RuleReason.NoClassifiedConcepts ||
        value.reason === RuleReason.UnavailableTieAmount)
    )
  }

  return (
    (value.status === RuleStatus.Resolved ||
      value.status === RuleStatus.Provisional) &&
    isCanonicalCategory(value.category) &&
    text(value.criterion) &&
    [
      RuleCriterion.ConceptCount,
      RuleCriterion.NetAmount,
      RuleCriterion.FirstOccurrence,
    ].some((criterion) => criterion === value.criterion) &&
    value.reason === null
  )
}

const issueCodes = new Set<string>([
  InvoiceIssueCode.MissingField,
  InvoiceIssueCode.InvalidField,
  InvoiceIssueCode.InvalidAmount,
  InvoiceIssueCode.UnrepresentableCents,
  InvoiceIssueCode.MissingCurrency,
  InvoiceIssueCode.UnknownCurrency,
  InvoiceIssueCode.MissingDescription,
  InvoiceIssueCode.InvalidUnicode,
  InvoiceIssueCode.UnresolvedInvoiceCategory,
])

export function validateIssue(value: unknown): value is InvoiceIssue {
  return (
    fields(value, ['code', 'stage', 'field', 'conceptId']) &&
    text(value.code) &&
    issueCodes.has(value.code) &&
    text(value.stage) &&
    [
      InvoiceIssueStage.Extract,
      InvoiceIssueStage.Model,
      InvoiceIssueStage.InvoiceRules,
      InvoiceIssueStage.Presentation,
    ].some((stage) => stage === value.stage) &&
    text(value.field) &&
    value.field.startsWith('/') &&
    nullableNonempty(value.conceptId)
  )
}

export function validateConceptRecord(value: unknown): value is ConceptRecord {
  if (
    !fields(value, [
      'id',
      'position',
      'descriptionPresent',
      'description',
      'netAmount',
      'prediction',
      'selection',
    ]) ||
    !nonempty(value.id) ||
    !integer(value.position) ||
    !validateExactAmount(value.netAmount) ||
    !validatePrediction(value.prediction) ||
    !validateConceptSelection(value.selection)
  ) {
    return false
  }

  return (
    (value.descriptionPresent === false &&
      value.description === null &&
      value.prediction.status === 1) ||
    (value.descriptionPresent === true &&
      text(value.description) &&
      (value.prediction.status === 0 || value.prediction.status === 2))
  )
}

export function validateImportRecord(value: unknown): value is ImportRecord {
  return (
    fields(value, [
      'schemaVersion',
      'id',
      'name',
      'kind',
      'originalBytes',
      'createdAt',
    ]) &&
    value.schemaVersion === 1 &&
    nonempty(value.id) &&
    nonempty(value.name) &&
    (value.kind === SourceKind.Xml || value.kind === SourceKind.Zip) &&
    integer(value.originalBytes) &&
    timestamp(value.createdAt)
  )
}

export function validateModelPackageRecord(
  value: unknown,
): value is ModelPackageRecord {
  return (
    fields(value, [
      'schemaVersion',
      'id',
      'modelFile',
      'modelSha256',
      'sourceModelSha256',
      'runtimeSignature',
      'ortVersion',
      'unicodeVersion',
      'featureCount',
      'classes',
    ]) &&
    value.schemaVersion === 1 &&
    hash(value.id) &&
    nonempty(value.modelFile) &&
    hash(value.modelSha256) &&
    hash(value.sourceModelSha256) &&
    nonempty(value.runtimeSignature) &&
    nonempty(value.ortVersion) &&
    nonempty(value.unicodeVersion) &&
    integer(value.featureCount, 1) &&
    denseArray(value.classes) &&
    value.classes.length === 7 &&
    new Set(value.classes).size === 7 &&
    value.classes.every(isCanonicalCategory)
  )
}

export function validateInvoiceRecord(value: unknown): value is InvoiceRecord {
  if (
    !fields(
      value,
      [
        'schemaVersion',
        'accessKey',
        'id',
        'importId',
        'entryIndex',
        'entryPath',
        'modelPackageId',
        'revision',
        'createdAt',
        'updatedAt',
        'issuer',
        'number',
        'date',
        'currency',
        'total',
        'concepts',
        'classification',
        'issues',
      ],
      ['buyer'],
    ) ||
    value.schemaVersion !== 1 ||
    !nonempty(value.id) ||
    !nonempty(value.importId) ||
    typeof value.accessKey !== 'string' ||
    !/^\d{49}$/.test(value.accessKey) ||
    !integer(value.entryIndex) ||
    !nullableNonempty(value.entryPath) ||
    !hash(value.modelPackageId) ||
    !integer(value.revision, 1) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt))
  ) {
    return false
  }

  if (
    !fields(value.issuer, ['legalName', 'tradeName'], ['ruc']) ||
    !nullableNonempty(value.issuer.legalName) ||
    !nullableNonempty(value.issuer.tradeName) ||
    (Object.hasOwn(value.issuer, 'ruc') && !nullableNonempty(value.issuer.ruc))
  ) {
    return false
  }

  if (
    Object.hasOwn(value, 'buyer') &&
    (!fields(value.buyer, ['name', 'identification']) ||
      !nullableNonempty(value.buyer.name) ||
      !nullableNonempty(value.buyer.identification))
  ) {
    return false
  }

  if (
    !fields(value.number, ['establishment', 'pointOfIssue', 'sequential']) ||
    !Object.values(value.number).every(nullableNonempty)
  ) {
    return false
  }

  if (
    !fields(value.date, ['raw', 'iso']) ||
    !nullableText(value.date.raw) ||
    !(value.date.iso === null || canonicalDate(value.date.iso)) ||
    (value.date.raw === null && value.date.iso !== null)
  ) {
    return false
  }

  if (
    !fields(value.currency, ['raw', 'code']) ||
    !nullableText(value.currency.raw) ||
    (value.currency.code !== null && value.currency.code !== 'USD') ||
    (value.currency.raw === null && value.currency.code !== null)
  ) {
    return false
  }

  if (
    !validateExactAmount(value.total) ||
    !denseArray(value.concepts) ||
    !value.concepts.length ||
    !value.concepts.every(validateConceptRecord)
  ) {
    return false
  }

  const concepts = value.concepts as ConceptRecord[]

  if (
    new Set(concepts.map((concept) => concept.id)).size !== concepts.length ||
    !concepts.every((concept, index) => concept.position === index)
  ) {
    return false
  }

  if (
    !fields(value.classification, ['initial', 'automatic', 'selection']) ||
    !validateRuleResult(value.classification.initial) ||
    !validateRuleResult(value.classification.automatic) ||
    !validateInvoiceSelection(value.classification.selection)
  ) {
    return false
  }

  const ids = new Set(concepts.map((concept) => concept.id))

  return (
    denseArray(value.issues) &&
    value.issues.every(
      (issue) =>
        validateIssue(issue) &&
        (issue.conceptId === null || ids.has(issue.conceptId)),
    )
  )
}

export function cloneImportRecord(record: ImportRecord): ImportRecord {
  return {
    schemaVersion: 1,
    id: record.id,
    name: record.name,
    kind: record.kind,
    originalBytes: record.originalBytes,
    createdAt: record.createdAt,
  }
}

export function cloneModelPackageRecord(
  record: ModelPackageRecord,
): ModelPackageRecord {
  return {
    schemaVersion: 1,
    id: record.id,
    modelFile: record.modelFile,
    modelSha256: record.modelSha256,
    sourceModelSha256: record.sourceModelSha256,
    runtimeSignature: record.runtimeSignature,
    ortVersion: record.ortVersion,
    unicodeVersion: record.unicodeVersion,
    featureCount: record.featureCount,
    classes: [...record.classes],
  }
}

export function cloneRuleResult(rule: RuleResult): RuleResult {
  return {
    rulesVersion: rule.rulesVersion,
    status: rule.status,
    category: rule.category,
    criterion: rule.criterion,
    reason: rule.reason,
  } as RuleResult
}

export function clonePrediction(
  prediction: ConceptPrediction,
): ConceptPrediction {
  return {
    status: prediction.status,
    categoryIndex: prediction.categoryIndex,
    probabilities: [...prediction.probabilities],
  } as ConceptPrediction
}

export function cloneConceptRecord(concept: ConceptRecord): ConceptRecord {
  return {
    id: concept.id,
    position: concept.position,
    descriptionPresent: concept.descriptionPresent,
    description: concept.description,
    netAmount: {
      raw: concept.netAmount.raw,
      decimal: concept.netAmount.decimal,
    },
    prediction: clonePrediction(concept.prediction),
    selection:
      concept.selection.mode === SelectionMode.Model
        ? { mode: SelectionMode.Model }
        : { mode: SelectionMode.Manual, category: concept.selection.category },
  } as ConceptRecord
}

export function cloneIssue(issue: InvoiceIssue): InvoiceIssue {
  return {
    code: issue.code,
    stage: issue.stage,
    field: issue.field,
    conceptId: issue.conceptId,
  }
}

export function cloneInvoiceRecord(record: InvoiceRecord): InvoiceRecord {
  return {
    schemaVersion: 1,
    accessKey: record.accessKey,
    id: record.id,
    importId: record.importId,
    entryIndex: record.entryIndex,
    entryPath: record.entryPath,
    modelPackageId: record.modelPackageId,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    issuer: {
      legalName: record.issuer.legalName,
      tradeName: record.issuer.tradeName,
      ...(record.issuer.ruc !== undefined ? { ruc: record.issuer.ruc } : {}),
    },
    ...(record.buyer !== undefined
      ? {
          buyer: {
            name: record.buyer.name,
            identification: record.buyer.identification,
          },
        }
      : {}),
    number: {
      establishment: record.number.establishment,
      pointOfIssue: record.number.pointOfIssue,
      sequential: record.number.sequential,
    },
    date: {
      raw: record.date.raw,
      iso: record.date.iso,
    } as InvoiceRecord['date'],
    currency: {
      raw: record.currency.raw,
      code: record.currency.code,
    } as InvoiceRecord['currency'],
    total: {
      raw: record.total.raw,
      decimal: record.total.decimal,
    } as ExactAmount,
    concepts: record.concepts.map(
      cloneConceptRecord,
    ) as unknown as InvoiceRecord['concepts'],
    classification: {
      initial: cloneRuleResult(record.classification.initial),
      automatic: cloneRuleResult(record.classification.automatic),
      selection:
        record.classification.selection.mode === SelectionMode.Automatic
          ? { mode: SelectionMode.Automatic }
          : {
              mode: SelectionMode.Manual,
              category: record.classification.selection.category,
            },
    },
    issues: record.issues.map(cloneIssue),
  }
}

export function validateInvoiceReferences(
  invoice: InvoiceRecord,
  source: ImportRecord,
  pack: ModelPackageRecord,
): boolean {
  return (
    invoice.importId === source.id &&
    invoice.modelPackageId === pack.id &&
    (source.kind === SourceKind.Xml
      ? invoice.entryIndex === 0 && invoice.entryPath === null
      : invoice.entryPath !== null)
  )
}

export function validatePersistenceSnapshot(
  snapshot: LocalPersistenceSnapshot,
): boolean {
  if (
    !snapshot.imports.every(validateImportRecord) ||
    !snapshot.invoices.every(validateInvoiceRecord) ||
    !snapshot.modelPackages.every(validateModelPackageRecord)
  ) {
    return false
  }

  const imports = new Map(snapshot.imports.map((source) => [source.id, source]))
  const packs = new Map(snapshot.modelPackages.map((pack) => [pack.id, pack]))

  if (
    imports.size !== snapshot.imports.length ||
    packs.size !== snapshot.modelPackages.length ||
    new Set(snapshot.invoices.map((invoice) => invoice.id)).size !==
      snapshot.invoices.length
  ) {
    return false
  }

  const entries = new Map<string, Set<number>>()
  const usedPacks = new Set<string>()
  const accessKeys = new Set<string>()

  for (const invoice of snapshot.invoices) {
    if (accessKeys.has(invoice.accessKey)) {
      return false
    }

    accessKeys.add(invoice.accessKey)

    const source = imports.get(invoice.importId)
    const pack = packs.get(invoice.modelPackageId)

    if (!source || !pack || !validateInvoiceReferences(invoice, source, pack)) {
      return false
    }

    const indices = entries.get(invoice.importId) ?? new Set<number>()

    if (indices.has(invoice.entryIndex)) {
      return false
    }

    indices.add(invoice.entryIndex)
    entries.set(invoice.importId, indices)
    usedPacks.add(invoice.modelPackageId)
  }

  return entries.size === imports.size && usedPacks.size === packs.size
}
