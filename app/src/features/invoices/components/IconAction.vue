<script setup lang="ts">
import type { Component } from 'vue'
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from 'reka-ui'
import Button from '../../../shared/ui/button/Button.vue'
import { IconActionTone } from '../../../shared/ui/iconActionTone'

const {
  disabled = false,
  destructive = false,
  tone = undefined,
} = defineProps<{
  icon: Component
  tooltip: string
  label: string
  disabled?: boolean
  destructive?: boolean
  tone?: IconActionTone
}>()
const emit = defineEmits<{ click: [] }>()

const tones = {
  [IconActionTone.Positive]:
    'enabled:hover:border-success enabled:hover:bg-success-soft enabled:hover:text-success',
  [IconActionTone.Cancel]:
    'enabled:hover:border-danger enabled:hover:bg-danger-soft enabled:hover:text-danger',
  [IconActionTone.Edit]:
    'enabled:hover:border-primary enabled:hover:bg-primary-soft enabled:hover:text-primary',
  [IconActionTone.Restore]:
    'enabled:hover:border-warning enabled:hover:bg-warning-soft enabled:hover:text-warning',
}
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <Button
          type="button"
          size="icon"
          variant="outline"
          class="size-8 shrink-0 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :class="[
            destructive ? tones[IconActionTone.Cancel] : '',
            tone ? tones[tone] : '',
          ]"
          :disabled="disabled"
          :aria-label="label"
          @click="emit('click')"
        >
          <component
            :is="icon"
            :size="15"
            aria-hidden="true"
          />
        </Button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          class="z-[100] rounded-md bg-ink px-2.5 py-1.5 text-xs text-white shadow-md"
          :side-offset="5"
        >
          {{ tooltip }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
