import { defineStore } from 'pinia'
import { computed, onScopeDispose, shallowRef } from 'vue'

import { InvoiceSnapshotKind } from '../domain/invoiceSnapshot'
import type { InvoiceData } from '../domain/storageModel'
import { useInvoiceService } from '../services/invoiceService'

export type InvoiceSnapshot =
  | {
      kind:
        typeof InvoiceSnapshotKind.Unknown | typeof InvoiceSnapshotKind.Loading
    }
  | ({ kind: typeof InvoiceSnapshotKind.Ready } & InvoiceData)
  | {
      kind: typeof InvoiceSnapshotKind.Error
      message: string
      code?: string
    }

export const useInvoiceStore = defineStore('invoices', () => {
  const service = useInvoiceService()

  const snapshot = shallowRef<InvoiceSnapshot>({
    kind: InvoiceSnapshotKind.Unknown,
  })
  const hasInvoices = computed(
    () =>
      snapshot.value.kind === InvoiceSnapshotKind.Ready &&
      snapshot.value.invoices.length > 0,
  )
  const celebrated = shallowRef(false)

  let revision = 0
  let initialization: Promise<InvoiceSnapshot> | undefined

  onScopeDispose(() => {
    revision++
  })

  function invalidateReads() {
    revision++
  }

  function publish(data: InvoiceData) {
    invalidateReads()
    snapshot.value = { kind: InvoiceSnapshotKind.Ready, ...data }
  }

  async function refresh(): Promise<InvoiceSnapshot> {
    const requestRevision = ++revision

    if (snapshot.value.kind !== InvoiceSnapshotKind.Ready) {
      snapshot.value = { kind: InvoiceSnapshotKind.Loading }
    }

    try {
      const result = await service.read()

      if (requestRevision === revision) {
        snapshot.value = result.ok
          ? { kind: InvoiceSnapshotKind.Ready, ...result.value }
          : {
              kind: InvoiceSnapshotKind.Error,
              message: result.message,
              code: result.code,
            }
      }
    } catch {
      if (requestRevision === revision) {
        snapshot.value = {
          kind: InvoiceSnapshotKind.Error,
          message: 'No se pudieron cargar las facturas.',
        }
      }
    }

    return snapshot.value
  }

  function initialize(): Promise<InvoiceSnapshot> {
    if (initialization) {
      return initialization
    }

    if (snapshot.value.kind !== InvoiceSnapshotKind.Unknown) {
      return Promise.resolve(snapshot.value)
    }

    initialization = refresh().finally(() => {
      initialization = undefined
    })

    return initialization
  }

  function claimFirstCelebration(beforeEmpty: boolean, saved: number): boolean {
    if (
      celebrated.value ||
      !beforeEmpty ||
      saved <= 0 ||
      snapshot.value.kind !== InvoiceSnapshotKind.Ready ||
      !snapshot.value.invoices.length
    ) {
      return false
    }

    celebrated.value = true

    return true
  }

  return {
    snapshot,
    hasInvoices,
    celebrated,
    initialize,
    refresh,
    publish,
    invalidateReads,
    claimFirstCelebration,
  }
})
