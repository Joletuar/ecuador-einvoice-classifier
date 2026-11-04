import { computed, watch } from 'vue'

import { InvoiceSnapshotKind } from '../domain/invoiceSnapshot'
import { useInvoiceStore } from '../stores/useInvoiceStore'
import { useInvoiceListStore } from '../stores/useInvoiceListStore'
import { presentInvoiceList } from '../presentation/invoiceListPresenter'

export function useInvoiceList() {
  const invoicesStore = useInvoiceStore()
  const preferences = useInvoiceListStore()

  const invoices = computed(() =>
    invoicesStore.snapshot.kind === InvoiceSnapshotKind.Ready
      ? invoicesStore.snapshot.invoices
      : [],
  )
  const list = computed(() =>
    presentInvoiceList(
      invoices.value,
      preferences.appliedFilters,
      preferences.page,
      preferences.pageSize,
    ),
  )

  watch(() => list.value.pagination.page, preferences.setPage, {
    immediate: true,
  })

  return { invoices, list, preferences }
}
