export const RouteName = {
  Upload: 'upload',
  Invoices: 'invoices',
  Information: 'information',
} as const

export type RouteName = (typeof RouteName)[keyof typeof RouteName]
