export interface Filter {
  year: string
  query: string
  category: string
}

export function appliedInvoiceQuery(value: string): string {
  const query = value.trim()

  return Array.from(query).length >= 3 ? query.toLocaleLowerCase('es') : ''
}
