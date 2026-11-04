import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

import {
  InvoiceStoreName,
  InvoiceIndexName,
} from '../domain/persistenceRecords'
import { StorageErrorCode } from '../domain/storageErrors'
import { CommitStatus } from '../../../workers/workerProtocol'
import {
  InvoiceIssueCode,
  InvoiceIssueStage,
  RuleStatus,
  SelectionMode,
} from '../domain/classificationModel'
import type { StorageLimits } from '../../../app/config/storageLimits'
import {
  CoordinationFailure,
  createTabCoordinator,
  type TabCoordinator,
} from '../../../app/tabCoordination'
import type { Result } from '../../../shared/lib/result'
import type {
  ConceptRecord,
  ConceptSelection,
  InvoiceSelection,
} from '../domain/classificationModel'
import type {
  ImportRecord,
  InvoiceRecord,
  LocalPersistenceSnapshot,
  ModelPackageRecord,
} from '../domain/persistenceRecords'
import {
  cloneImportRecord,
  cloneInvoiceRecord,
  cloneModelPackageRecord,
  cloneRuleResult,
  cloneIssue,
  fields,
  plain,
  validateConceptSelection,
  validateImportRecord,
  validateInvoiceRecord,
  validateInvoiceReferences,
  validateInvoiceSelection,
  validateIssue,
  validateModelPackageRecord,
  validatePersistenceSnapshot,
  validateRuleResult,
} from '../domain/persistenceValidation'
import { projectInvoice } from '../domain/invoiceProjection'
import {
  createInvoiceData,
  permitsStorageChange,
  persistenceUsage,
  serializedRecordBytes,
  type InvoiceData,
  type StorageUsage,
} from '../domain/storageModel'
import type {
  CommittedInvoice,
  InvoiceCommit,
  InvoiceImportSession,
  InvoiceRecalculator,
  InvoiceService,
} from './invoiceService'

interface InvoiceDatabase extends DBSchema {
  imports: {
    key: string
    value: ImportRecord
    indexes: { byName: string }
  }
  invoices: {
    key: string
    value: InvoiceRecord
    indexes: {
      byImport: string
      byImportEntry: [string, number]
      byModelPackage: string
    }
  }
  modelPackages: {
    key: string
    value: ModelPackageRecord
  }
}

const stores = [
  InvoiceStoreName.Imports,
  InvoiceStoreName.Invoices,
  InvoiceStoreName.ModelPackages,
] as const

class StorageFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'StorageFailure'
  }
}

export class MigrationError extends StorageFailure {
  constructor() {
    super(
      StorageErrorCode.MigrationRequired,
      'La base anterior contiene facturas que no pueden migrarse conservando su modelo y probabilidades. Se ha conservado intacta.',
    )
    this.name = 'MigrationError'
  }
}

function failure<T>(
  error: unknown,
  code: StorageErrorCode = StorageErrorCode.WriteFailed,
): Result<T> {
  if (error instanceof StorageFailure || error instanceof CoordinationFailure) {
    return { ok: false, code: error.code, message: error.message }
  }

  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return {
      ok: false,
      code: StorageErrorCode.Limit,
      message: 'El navegador no dispone de espacio para guardar esta factura.',
    }
  }

  return {
    ok: false,
    code,
    message: 'No se pudo confirmar la operación de facturas.',
  }
}

function invalid(): never {
  throw new StorageFailure(
    StorageErrorCode.InvalidPayload,
    'Los registros de factura no cumplen el contrato de persistencia.',
  )
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Las categorías corregidas también pueden pertenecer a la antigua demo. Para
// reconocer esos datos se comprueban sus identificadores y su procedencia.
function simulatedInvoice(
  invoice: unknown,
  source: Record<string, unknown>,
): boolean {
  if (
    !plain(invoice) ||
    typeof source.id !== 'string' ||
    typeof source.name !== 'string' ||
    !Array.isArray(invoice.concepts) ||
    invoice.concepts.length !== 1
  ) {
    return false
  }

  const concept = invoice.concepts[0]

  if (
    !plain(concept) ||
    invoice.id !== `simulated:${source.id}` ||
    concept.id !== `${invoice.id}:concept`
  ) {
    return false
  }

  const current =
    invoice.issuer === source.name &&
    invoice.number === `FAC-${source.id.slice(0, 8)}` &&
    concept.name === `Detalle de ${source.name}`
  const original =
    invoice.issuer === `Simulación — ${source.name}` &&
    [`SIM-${source.id}`, `SIM-${source.id.slice(0, 8)}`].includes(
      String(invoice.number),
    ) &&
    concept.name === `Concepto simulado de ${source.name}`

  return current || original
}

function removableLegacyOrigin(value: unknown): boolean {
  return (
    plain(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    Array.isArray(value.invoices) &&
    value.invoices.every((invoice) => simulatedInvoice(invoice, value))
  )
}

interface State {
  imports: Map<string, ImportRecord>
  invoices: Map<string, InvoiceRecord>
  packages: Map<string, ModelPackageRecord>
  entries: Map<string, Map<number, string>>
  names: Map<string, string>
  usage: StorageUsage
}

function snapshot(state: State): LocalPersistenceSnapshot {
  return {
    imports: [...state.imports.values()],
    invoices: [...state.invoices.values()],
    modelPackages: [...state.packages.values()],
  }
}

function stateFrom(records: LocalPersistenceSnapshot): State {
  if (!validatePersistenceSnapshot(records)) {
    throw new StorageFailure(
      StorageErrorCode.Unavailable,
      'Los registros guardados no cumplen el contrato de facturas.',
    )
  }

  const imports = records.imports.map(cloneImportRecord)
  const invoices = records.invoices.map(cloneInvoiceRecord)
  const packages = records.modelPackages.map(cloneModelPackageRecord)

  const entries = new Map<string, Map<number, string>>()

  for (const invoice of invoices) {
    const indices = entries.get(invoice.importId) ?? new Map<number, string>()

    indices.set(invoice.entryIndex, invoice.id)
    entries.set(invoice.importId, indices)
  }

  return {
    imports: new Map(imports.map((source) => [source.id, source])),
    invoices: new Map(invoices.map((invoice) => [invoice.id, invoice])),
    packages: new Map(packages.map((pack) => [pack.id, pack])),
    entries,
    names: new Map(imports.map((source) => [source.name, source.id])),
    usage: persistenceUsage({ imports, invoices, modelPackages: packages }),
  }
}

function prepareCommit(input: InvoiceCommit): InvoiceCommit {
  if (
    !fields(input, ['source', 'modelPackage', 'invoice']) ||
    !validateImportRecord(input.source) ||
    !validateModelPackageRecord(input.modelPackage) ||
    !validateInvoiceRecord(input.invoice) ||
    !validateInvoiceReferences(input.invoice, input.source, input.modelPackage)
  ) {
    invalid()
  }

  return {
    source: cloneImportRecord(input.source),
    modelPackage: cloneModelPackageRecord(input.modelPackage),
    invoice: cloneInvoiceRecord(input.invoice),
  }
}

export function createIndexedDbInvoiceService(
  limits: StorageLimits,
  options: {
    databaseName?: string
    coordinator?: TabCoordinator
    recalculate?: InvoiceRecalculator
  } = {},
): InvoiceService {
  const databaseName = options.databaseName ?? 'facturas-locales'
  const coordinator =
    options.coordinator ??
    createTabCoordinator({ name: `${databaseName}:writer` })
  const ownsCoordinator = !options.coordinator

  let connection: Promise<IDBPDatabase<InvoiceDatabase>> | undefined
  let disposed = false

  async function database() {
    if (disposed || typeof indexedDB === 'undefined') {
      throw new StorageFailure(
        StorageErrorCode.Unavailable,
        'El almacenamiento de facturas no está disponible.',
      )
    }

    if (
      !Number.isSafeInteger(limits.maxFiles) ||
      limits.maxFiles <= 0 ||
      !Number.isSafeInteger(limits.maxTotalBytes) ||
      limits.maxTotalBytes <= 0
    ) {
      throw new StorageFailure(
        StorageErrorCode.Unavailable,
        'Los límites de almacenamiento no son válidos.',
      )
    }

    if (!connection) {
      let migrationFailure: MigrationError | undefined
      let abandoned = false
      let rejectBlocked!: (error: StorageFailure) => void
      const blocked = new Promise<never>((_resolve, reject) => {
        rejectBlocked = reject
      })
      const opening = openDB<InvoiceDatabase>(databaseName, 3, {
        async upgrade(db, previousVersion, _nextVersion, transaction) {
          void transaction.done.catch(() => undefined)

          // La apertura de la base puede continuar después de soltar el turno
          // de escritura. En ese caso se cancela la migración para evitar
          // cambios sin el bloqueo.
          if (abandoned || disposed) {
            transaction.abort()

            return
          }

          try {
            if (previousVersion !== 0) {
              if (
                db.objectStoreNames.length !== 1 ||
                !db.objectStoreNames.contains(InvoiceStoreName.Imports) ||
                previousVersion > 2
              ) {
                throw new MigrationError()
              }

              const legacy: unknown[] = await transaction
                .objectStore(InvoiceStoreName.Imports)
                .getAll()

              if (!legacy.every(removableLegacyOrigin)) {
                throw new MigrationError()
              }

              db.deleteObjectStore(InvoiceStoreName.Imports)
            }

            const imports = db.createObjectStore(InvoiceStoreName.Imports, {
              keyPath: 'id',
            })

            imports.createIndex(InvoiceIndexName.ByName, 'name', {
              unique: true,
            })

            const invoices = db.createObjectStore(InvoiceStoreName.Invoices, {
              keyPath: 'id',
            })

            invoices.createIndex(InvoiceIndexName.ByImport, 'importId')
            invoices.createIndex(
              InvoiceIndexName.ByImportEntry,
              ['importId', 'entryIndex'],
              {
                unique: true,
              },
            )
            invoices.createIndex(
              InvoiceIndexName.ByModelPackage,
              'modelPackageId',
            )
            db.createObjectStore(InvoiceStoreName.ModelPackages, {
              keyPath: 'id',
            })
          } catch (error) {
            migrationFailure =
              error instanceof MigrationError ? error : new MigrationError()
            transaction.abort()
          }
        },

        blocked() {
          abandoned = true

          if (connection === attempt) {
            connection = undefined
          }

          rejectBlocked(
            new StorageFailure(
              StorageErrorCode.UpgradeBlocked,
              'Otra pestaña mantiene abierta la base anterior. Ciérrala y vuelve a intentar.',
            ),
          )
        },

        blocking() {
          void connection?.then((db) => db.close()).catch(() => undefined)
          connection = undefined
        },

        terminated() {
          connection = undefined
        },
      })
        .then((db) => {
          if (abandoned || disposed) {
            db.close()

            throw new StorageFailure(
              StorageErrorCode.UpgradeBlocked,
              'La apertura de la base quedó interrumpida. Vuelve a intentar.',
            )
          }

          return db
        })
        .catch((error: unknown) => {
          if (migrationFailure) {
            throw migrationFailure
          }

          if (connection === attempt) {
            connection = undefined
          }

          throw error
        })
      const attempt = Promise.race([opening, blocked])

      connection = attempt
    }

    try {
      const db = await connection

      if (disposed) {
        db.close()

        throw new StorageFailure(
          StorageErrorCode.Unavailable,
          'La conexión de facturas está cerrada.',
        )
      }

      return db
    } catch (error) {
      if (error instanceof MigrationError || error instanceof StorageFailure) {
        throw error
      }

      throw new StorageFailure(
        StorageErrorCode.Unavailable,
        'No se puede abrir el almacenamiento de facturas.',
      )
    }
  }

  async function load(): Promise<State> {
    const db = await database()

    const transaction = db.transaction(stores, 'readonly')

    const [imports, invoices, modelPackages] = await Promise.all([
      transaction.objectStore(InvoiceStoreName.Imports).getAll(),
      transaction.objectStore(InvoiceStoreName.Invoices).getAll(),
      transaction.objectStore(InvoiceStoreName.ModelPackages).getAll(),
    ])

    await transaction.done

    return stateFrom({ imports, invoices, modelPackages })
  }

  function view(state: State) {
    return createInvoiceData(snapshot(state), state.usage)
  }

  function notifyChanged() {
    try {
      coordinator.notifyChanged()
    } catch {
      // El guardado ya terminó. Un fallo al avisar a otras pestañas no
      // puede deshacerlo.
    }
  }

  function checkQuota(before: StorageUsage, after: StorageUsage) {
    if (
      !Number.isSafeInteger(after.bytes) ||
      after.bytes < 0 ||
      !permitsStorageChange(before, after, limits)
    ) {
      throw new StorageFailure(
        StorageErrorCode.Limit,
        'Se alcanzó el límite de almacenamiento de facturas.',
      )
    }
  }

  async function writer<T>(work: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await coordinator.withWriter(work) }
    } catch (error) {
      return failure(error)
    }
  }

  async function committed(
    state: State,
    input: InvoiceCommit,
  ): Promise<CommittedInvoice> {
    const existingId = state.entries
      .get(input.source.id)
      ?.get(input.invoice.entryIndex)

    if (existingId) {
      const existing = state.invoices.get(existingId)!

      return {
        status: CommitStatus.AlreadySaved,
        invoice: projectInvoice(
          existing,
          state.imports.get(existing.importId)!,
          state.packages.get(existing.modelPackageId)!,
        ),
        revision: existing.revision,
        usage: { ...state.usage },
      }
    }

    if (
      input.invoice.revision !== 1 ||
      input.invoice.classification.selection.mode !== SelectionMode.Automatic ||
      input.invoice.concepts.some(
        (concept) => concept.selection.mode !== SelectionMode.Model,
      ) ||
      !same(
        input.invoice.classification.initial,
        input.invoice.classification.automatic,
      )
    ) {
      invalid()
    }

    const source = state.imports.get(input.source.id)
    const pack = state.packages.get(input.modelPackage.id)

    if (
      (source && !same(source, input.source)) ||
      (pack && !same(pack, input.modelPackage))
    ) {
      invalid()
    }

    if (state.invoices.has(input.invoice.id)) {
      throw new StorageFailure(
        StorageErrorCode.Conflict,
        'El identificador de factura ya pertenece a otra entrada.',
      )
    }

    const sameName = state.names.get(input.source.name)

    if (sameName && sameName !== input.source.id) {
      throw new StorageFailure(
        StorageErrorCode.DuplicateSource,
        'Ya hay facturas guardadas con ese nombre de archivo.',
      )
    }

    const after = {
      files: state.usage.files + (source ? 0 : 1),
      bytes:
        state.usage.bytes +
        serializedRecordBytes(input.invoice) +
        (source ? 0 : serializedRecordBytes(input.source)) +
        (pack ? 0 : serializedRecordBytes(input.modelPackage)),
    }

    checkQuota(state.usage, after)

    const db = await database()

    const transaction = db.transaction(stores, 'readwrite')

    void transaction.done.catch(() => undefined)

    try {
      if (!source) {
        await transaction
          .objectStore(InvoiceStoreName.Imports)
          .add(input.source)
      }

      if (!pack) {
        await transaction
          .objectStore(InvoiceStoreName.ModelPackages)
          .add(input.modelPackage)
      }

      await transaction
        .objectStore(InvoiceStoreName.Invoices)
        .add(input.invoice)
      await transaction.done
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // Si la transacción ya terminó, abort no puede cancelarla. Ese fallo
        // no debe ocultar el error original de guardado.
      }

      await transaction.done.catch(() => undefined)

      throw error
    }

    state.imports.set(input.source.id, input.source)
    state.names.set(input.source.name, input.source.id)
    state.packages.set(input.modelPackage.id, input.modelPackage)
    state.invoices.set(input.invoice.id, input.invoice)

    const indices =
      state.entries.get(input.source.id) ?? new Map<number, string>()

    indices.set(input.invoice.entryIndex, input.invoice.id)
    state.entries.set(input.source.id, indices)
    state.usage = after
    notifyChanged()

    return {
      status: CommitStatus.Saved,
      invoice: projectInvoice(input.invoice, input.source, input.modelPackage),
      revision: input.invoice.revision,
      usage: { ...after },
    }
  }

  async function correction(input: {
    invoiceId: string
    expectedRevision?: number
    conceptId?: string
    selection: ConceptSelection | InvoiceSelection
  }): Promise<Result<InvoiceData>> {
    // Se copia la petición antes de esperar el turno de escritura para que los
    // cambios del formulario no alteren la operación en curso.
    input = { ...input, selection: { ...input.selection } }

    return writer(async () => {
      if (
        input.conceptId === undefined
          ? !validateInvoiceSelection(input.selection)
          : !validateConceptSelection(input.selection)
      ) {
        invalid()
      }

      const state = await load()

      const current = state.invoices.get(input.invoiceId)

      if (!current) {
        throw new StorageFailure(
          StorageErrorCode.InvoiceNotFound,
          'La factura ya no está guardada.',
        )
      }

      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw new StorageFailure(
          StorageErrorCode.Conflict,
          'La factura cambió. Actualiza la vista antes de corregirla.',
        )
      }

      if (
        input.conceptId !== undefined &&
        !current.concepts.some((concept) => concept.id === input.conceptId)
      ) {
        throw new StorageFailure(
          StorageErrorCode.ConceptNotFound,
          'El concepto ya no está guardado.',
        )
      }

      if (!options.recalculate) {
        throw new StorageFailure(
          StorageErrorCode.RulesUnavailable,
          'El Worker de reglas no está disponible.',
        )
      }

      const concepts = current.concepts.map((concept) =>
        concept.id === input.conceptId
          ? {
              ...concept,
              selection: { ...input.selection } as ConceptSelection,
            }
          : concept,
      ) as unknown as InvoiceRecord['concepts']
      const selection =
        input.conceptId === undefined
          ? ({ ...input.selection } as InvoiceSelection)
          : current.classification.selection

      const recalculated = await options.recalculate({
        invoiceId: current.id,
        expectedRevision: current.revision,
        classes: [...state.packages.get(current.modelPackageId)!.classes],
        concepts: concepts.map((concept) => ({
          id: concept.id,
          position: concept.position,
          netAmount: { ...concept.netAmount },
          prediction: {
            ...concept.prediction,
            probabilities: [...concept.prediction.probabilities],
          } as ConceptRecord['prediction'],
          selection: { ...concept.selection },
        })),
        selection: { ...selection },
      })

      if (
        recalculated.invoiceId !== current.id ||
        recalculated.expectedRevision !== current.revision ||
        !same(recalculated.selection, selection) ||
        !validateRuleResult(recalculated.evaluation?.result) ||
        !Array.isArray(recalculated.evaluation.issues) ||
        !recalculated.evaluation.issues.every(validateIssue)
      ) {
        throw new StorageFailure(
          StorageErrorCode.RulesFailed,
          'El Worker no confirmó el recálculo de esta revisión.',
        )
      }

      const issues = current.issues.filter(
        (issue) => issue.stage !== InvoiceIssueStage.InvoiceRules,
      )

      issues.push(...recalculated.evaluation.issues.map(cloneIssue))

      if (recalculated.evaluation.result.status === RuleStatus.Unassigned) {
        issues.push({
          code: InvoiceIssueCode.UnresolvedInvoiceCategory,
          stage: InvoiceIssueStage.InvoiceRules,
          field: '/classification/automatic',
          conceptId: null,
        })
      }

      const now = new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt)),
      ).toISOString()
      const updated = cloneInvoiceRecord({
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        concepts,
        classification: {
          initial: current.classification.initial,
          automatic: cloneRuleResult(recalculated.evaluation.result),
          selection,
        },
        issues,
      })

      if (!validateInvoiceRecord(updated)) {
        invalid()
      }

      const after = {
        files: state.usage.files,
        bytes:
          state.usage.bytes -
          serializedRecordBytes(current) +
          serializedRecordBytes(updated),
      }

      checkQuota(state.usage, after)

      const db = await database()

      const transaction = db.transaction(InvoiceStoreName.Invoices, 'readwrite')

      void transaction.done.catch(() => undefined)

      try {
        const latest = await transaction.store.get(current.id)

        if (!latest || latest.revision !== current.revision) {
          throw new StorageFailure(
            StorageErrorCode.Conflict,
            'La factura cambió durante el recálculo. Actualiza la vista.',
          )
        }

        await transaction.store.put(updated)
        await transaction.done
      } catch (error) {
        try {
          transaction.abort()
        } catch {
          // Si la transacción ya terminó, abort no puede cancelarla. Ese fallo
          // no debe ocultar el error original de la corrección.
        }

        await transaction.done.catch(() => undefined)

        throw error
      }

      state.invoices.set(updated.id, updated)
      state.usage = after
      notifyChanged()

      return view(state)
    })
  }

  return {
    async read() {
      try {
        return { ok: true, value: view(await load()) }
      } catch (error) {
        return failure(error, StorageErrorCode.Unavailable)
      }
    },

    withImportSession(work) {
      return writer(async () => {
        const state = await load()

        let accepting = true
        let tail: Promise<unknown> = Promise.resolve()
        const requireActive = () => {
          if (!accepting) {
            throw new StorageFailure(
              StorageErrorCode.SessionClosed,
              'La sesión de importación está cerrada.',
            )
          }
        }
        const session: InvoiceImportSession = {
          sourceIds: Object.freeze([...state.imports.keys()]),
          sourceNames: Object.freeze([...state.names.keys()]),

          commit(input) {
            try {
              requireActive()

              const prepared = prepareCommit(input)
              const result = tail.then(
                async (): Promise<Result<CommittedInvoice>> => {
                  try {
                    return {
                      ok: true,
                      value: await committed(state, prepared),
                    }
                  } catch (error) {
                    return failure(error)
                  }
                },
              )

              tail = result

              return result
            } catch (error) {
              return Promise.resolve(failure(error))
            }
          },

          findSaved(importId, entryIndex) {
            requireActive()

            const id = state.entries.get(importId)?.get(entryIndex)
            const record = id ? state.invoices.get(id) : undefined

            return record
              ? projectInvoice(
                  record,
                  state.imports.get(record.importId)!,
                  state.packages.get(record.modelPackageId)!,
                )
              : null
          },

          snapshot() {
            requireActive()

            return view(state)
          },
        }

        try {
          return await work(session)
        } finally {
          accepting = false

          await tail
        }
      })
    },

    correct: (input) => correction(input),

    correctInvoiceCategory: (input) => correction(input),

    remove(id) {
      return writer(async () => {
        const state = await load()

        const invoice = state.invoices.get(id)

        if (!invoice) {
          throw new StorageFailure(
            StorageErrorCode.InvoiceNotFound,
            'La factura ya no está guardada.',
          )
        }

        const indices = state.entries.get(invoice.importId)!
        const removeSource = indices.size === 1
        const removePack = ![...state.invoices.values()].some(
          (other) =>
            other.id !== id && other.modelPackageId === invoice.modelPackageId,
        )

        const db = await database()

        const transaction = db.transaction(stores, 'readwrite')

        void transaction.done.catch(() => undefined)

        try {
          await transaction.objectStore(InvoiceStoreName.Invoices).delete(id)

          if (removeSource) {
            await transaction
              .objectStore(InvoiceStoreName.Imports)
              .delete(invoice.importId)
          }

          if (removePack) {
            await transaction
              .objectStore(InvoiceStoreName.ModelPackages)
              .delete(invoice.modelPackageId)
          }

          await transaction.done
        } catch (error) {
          try {
            transaction.abort()
          } catch {
            // Si la transacción ya terminó, abort no puede cancelarla. Ese fallo
            // no debe ocultar el error original al eliminar la factura.
          }

          await transaction.done.catch(() => undefined)

          throw error
        }

        state.invoices.delete(id)
        indices.delete(invoice.entryIndex)

        if (removeSource) {
          const source = state.imports.get(invoice.importId)!

          state.imports.delete(invoice.importId)
          state.names.delete(source.name)
          state.entries.delete(invoice.importId)
        }

        if (removePack) {
          state.packages.delete(invoice.modelPackageId)
        }

        state.usage = persistenceUsage(snapshot(state))
        notifyChanged()

        return view(state)
      })
    },

    clearAll() {
      return writer(async () => {
        const db = await database()

        const transaction = db.transaction(stores, 'readwrite')

        void transaction.done.catch(() => undefined)

        try {
          await Promise.all(
            stores.map((name) => transaction.objectStore(name).clear()),
          )
          await transaction.done
        } catch (error) {
          try {
            transaction.abort()
          } catch {
            // Si la transacción ya terminó, abort no puede cancelarla. Ese fallo
            // no debe ocultar el error original al borrar los datos.
          }

          await transaction.done.catch(() => undefined)

          throw error
        }

        notifyChanged()

        return createInvoiceData({
          imports: [],
          invoices: [],
          modelPackages: [],
        })
      })
    },

    dispose() {
      disposed = true
      void connection?.then((db) => db.close()).catch(() => undefined)

      if (ownsCoordinator) {
        coordinator.dispose()
      }
    },
  }
}
