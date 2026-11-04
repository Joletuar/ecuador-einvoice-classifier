import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { appliedInvoiceQuery, type Filter } from '../domain/invoiceFilters'

export const useInvoiceListStore = defineStore('invoice-list', () => {
  const filters = shallowRef<Filter>({ year: '', query: '', category: '' })
  const page = shallowRef(1)
  const pageSize = shallowRef(10)
  const expanded = shallowRef<string[]>([])
  const appliedFilters = computed<Filter>((previous) => {
    const next = {
      ...filters.value,
      query: appliedInvoiceQuery(filters.value.query),
    }

    return previous &&
      previous.query === next.query &&
      previous.year === next.year &&
      previous.category === next.category
      ? previous
      : next
  })

  function setFilter(key: keyof Filter, value: string) {
    const changed =
      key === 'query'
        ? appliedInvoiceQuery(value) !==
          appliedInvoiceQuery(filters.value.query)
        : value !== filters.value[key]

    filters.value = { ...filters.value, [key]: value }

    if (changed) {
      page.value = 1
    }
  }

  function clearFilters() {
    filters.value = { year: '', query: '', category: '' }
    page.value = 1
  }

  function setPage(value: number) {
    page.value = Math.max(1, value)
  }

  function setPageSize(value: number) {
    if (![10, 30, 50, 100].includes(value)) {
      return
    }

    pageSize.value = value
    page.value = 1
  }

  function toggleExpanded(id: string) {
    expanded.value = expanded.value.includes(id) ? [] : [id]
  }

  function forgetInvoice(id: string) {
    expanded.value = expanded.value.filter((value) => value !== id)
  }

  function resetCollection() {
    clearFilters()
    expanded.value = []
  }

  return {
    filters,
    appliedFilters,
    page,
    pageSize,
    expanded,
    setFilter,
    clearFilters,
    setPage,
    setPageSize,
    toggleExpanded,
    forgetInvoice,
    resetCollection,
  }
})
