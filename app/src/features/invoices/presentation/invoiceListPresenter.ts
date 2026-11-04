import { categories, type Category } from '../domain/categoryModel'
import {
  excludedTotalConcepts,
  filterInvoices,
  totals,
} from '../domain/invoiceDomain'
import { appliedInvoiceQuery, type Filter } from '../domain/invoiceFilters'
import type { Invoice } from '../domain/invoiceModel'
import { exactMoney, formatDate, money } from './invoiceFormatting'

export interface CategorySummaryView {
  category: string
  label: string
  cents: number | null
  amountLabel: string
  invoiceCount: number
  conceptCount: number
  hasAssociations: boolean
}

export interface InvoiceListRow {
  invoice: Invoice
  dateLabel: string
  totalLabel: string
}

export interface PaginationView {
  page: number
  pages: number
  from: number
  to: number
  total: number
}

function categoryCard(
  category: Category,
  cents: number | null,
  invoices: Invoice[],
): CategorySummaryView {
  let invoiceCount = 0
  let conceptCount = 0

  for (const invoice of invoices) {
    const matchingConcepts = invoice.concepts.reduce(
      (count, concept) => count + Number(concept.category === category),
      0,
    )

    conceptCount += matchingConcepts

    if (invoice.principal === category || matchingConcepts > 0) {
      invoiceCount++
    }
  }

  return {
    category,
    label: category,
    cents,
    amountLabel: money(cents),
    invoiceCount,
    conceptCount,
    hasAssociations: invoiceCount > 0 || conceptCount > 0,
  }
}

export function presentInvoiceList(
  invoices: Invoice[],
  filters: Filter,
  page: number,
  pageSize = 10,
) {
  const matches = filterInvoices(invoices, {
    ...filters,
    query: appliedInvoiceQuery(filters.query),
  })

  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const currentPage = Math.min(Math.max(page, 1), pages)
  const start = (currentPage - 1) * pageSize

  const sums = totals(matches)
  const cards = categories.map((category) =>
    categoryCard(
      category,
      sums[category] === undefined ? 0 : sums[category]!,
      matches,
    ),
  )

  const rows: InvoiceListRow[] = matches
    .slice(start, start + pageSize)
    .map((invoice) => ({
      invoice,
      dateLabel: formatDate(invoice.date),
      totalLabel: exactMoney(invoice.totalAmount, invoice.currency),
    }))
  const pagination: PaginationView = {
    page: currentPage,
    pages,
    from: matches.length ? start + 1 : 0,
    to: Math.min(start + pageSize, matches.length),
    total: matches.length,
  }

  const yearOptions = [
    ...new Set(
      invoices.flatMap((invoice) =>
        invoice.date ? [invoice.date.slice(0, 4)] : [],
      ),
    ),
  ]
    .filter(Boolean)
    .sort()
    .reverse()

  return {
    rows,
    cards,
    yearOptions,
    pagination,
    excludedConcepts: excludedTotalConcepts(matches),
    unavailableTotals: Object.values(sums).some((value) => value === null),
  }
}
