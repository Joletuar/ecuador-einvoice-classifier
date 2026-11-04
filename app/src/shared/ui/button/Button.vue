<script setup lang="ts">
// Adapted from shadcn-vue new-york-v4 button registry.
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { Primitive } from 'reka-ui'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { buttonVariants, type ButtonVariants } from '.'

defineOptions({ name: 'ShadcnButton' })

interface Props extends PrimitiveProps {
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
  variant: 'default',
  size: 'default',
  class: undefined,
})
</script>
<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :class="twMerge(clsx(buttonVariants({ variant, size }), props.class))"
  >
    <slot />
  </Primitive>
</template>
