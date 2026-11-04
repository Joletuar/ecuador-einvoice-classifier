export const FeedbackTone = {
  Neutral: 'neutral',
  Primary: 'primary',
  Success: 'success',
  Warning: 'warning',
  Danger: 'danger',
} as const

export type FeedbackTone = (typeof FeedbackTone)[keyof typeof FeedbackTone]
