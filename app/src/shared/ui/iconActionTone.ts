export const IconActionTone = {
  Positive: 'positive',
  Cancel: 'cancel',
  Edit: 'edit',
  Restore: 'restore',
} as const

export type IconActionTone =
  (typeof IconActionTone)[keyof typeof IconActionTone]
