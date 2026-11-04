// Adapted from shadcn-vue new-york-v4 button registry.
import { cva, type VariantProps } from 'class-variance-authority'

export { default as Button } from './Button.vue'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        default: 'bg-primary text-white hover:bg-primary-strong',
        success: 'bg-success text-white hover:bg-success-strong',
        outline: 'border border-line bg-surface text-ink hover:bg-canvas',
        ghost: 'text-primary hover:bg-canvas',
        destructive: 'bg-danger text-white hover:bg-danger-strong',
      },
      size: { default: 'h-9 px-4', sm: 'h-8 px-3', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>
