import { Filter } from './invoiceFilters'
import { Invoice } from './invoiceModel'
import { Category } from './categoryModel'

export const filterInvoices = (
  invoices: Invoice[],
  filters: Filter,
): Invoice[] => {
  const query = filters.query.trim().toLocaleLowerCase('es')

  return invoices.filter((invoice) => {
    const matchesYear =
      !filters.year || Boolean(invoice.date?.startsWith(`${filters.year}-`))

    const matchesQuery =
      !query ||
      `${invoice.issuer ?? ''} ${invoice.number ?? ''}`
        .toLocaleLowerCase('es')
        .includes(query)

    const matchesCategory =
      !filters.category ||
      invoice.principal === filters.category ||
      invoice.concepts.some((concept) => concept.category === filters.category)

    return matchesYear && matchesQuery && matchesCategory
  })
}

export function totals(
  invoices: Invoice[],
): Partial<Record<Category, number | null>> {
  const exact: Partial<Record<Category, bigint>> = {}

  for (const invoice of invoices) {
    if (invoice.currency.code === 'USD') {
      for (const concept of invoice.concepts) {
        if (concept.cents !== null) {
          exact[concept.category] =
            (exact[concept.category] ?? 0n) + BigInt(concept.cents)
        }
      }
    }
  }

  const sums: Partial<Record<Category, number | null>> = {}

  for (const [category, cents] of Object.entries(exact)) {
    const value = Number(cents)

    sums[category as Category] = Number.isSafeInteger(value) ? value : null
  }

  return sums
}

export function excludedTotalConcepts(invoices: Invoice[]): number {
  return invoices.reduce(
    (count, invoice) =>
      count +
      invoice.concepts.filter(
        (concept) => invoice.currency.code !== 'USD' || concept.cents === null,
      ).length,
    0,
  )
}
