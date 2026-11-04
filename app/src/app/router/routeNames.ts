export const RouteName = {
  Upload: 'upload',
  Invoices: 'invoices',
} as const

export type RouteName = (typeof RouteName)[keyof typeof RouteName]
