<script setup lang="ts">
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { useTemplateRef } from 'vue'

import { FeedbackTone } from './feedbackTone'
import Button from './button/Button.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    confirmLabel: string
    cancelLabel?: string
    tone?: typeof FeedbackTone.Danger | typeof FeedbackTone.Primary
    restoreFocus?: boolean
    busy?: boolean
    confirmDisabled?: boolean
  }>(),
  {
    description: '',
    cancelLabel: 'Cancelar',
    tone: FeedbackTone.Danger,
    restoreFocus: true,
    busy: false,
    confirmDisabled: false,
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const cancelButton = useTemplateRef<InstanceType<typeof Button>>('cancelButton')

function initialFocus(event: Event) {
  event.preventDefault()

  const element = cancelButton.value?.$el

  if (element instanceof HTMLElement) {
    element.focus()
  }
}

function cancel() {
  if (!props.busy) {
    emit('cancel')
  }
}
</script>

<template>
  <DialogRoot
    :open="open"
    @update:open="!$event && cancel()"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-80 bg-ink/40" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-90 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-line bg-surface p-6 shadow-lg"
        :aria-busy="busy || undefined"
        @open-auto-focus="initialFocus"
        @close-auto-focus="!props.restoreFocus && $event.preventDefault()"
        @escape-key-down.prevent="cancel"
        @pointer-down-outside.prevent="cancel"
      >
        <DialogTitle
          class="mb-4 border-b border-line pb-4 text-xl font-bold text-ink"
        >
          {{ title }}
        </DialogTitle>
        <DialogDescription class="text-sm text-ink-muted">
          <slot>{{ description }}</slot>
        </DialogDescription>
        <div class="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            :disabled="busy"
            @click="cancel"
          >
            {{ cancelLabel }}
          </Button>
          <Button
            type="button"
            :variant="tone === FeedbackTone.Danger ? 'destructive' : 'default'"
            :disabled="busy || confirmDisabled"
            @click="!busy && !confirmDisabled && emit('confirm')"
          >
            {{ confirmLabel }}
          </Button>
        </div>
        <slot name="feedback" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
