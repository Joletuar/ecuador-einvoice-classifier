<script setup lang="ts">
import { shallowRef, useTemplateRef } from 'vue'
import { Upload } from 'lucide-vue-next'

const { disabled = false } = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ add: [files: File[]] }>()

const input = useTemplateRef<HTMLInputElement>('fileInput')

const dragging = shallowRef(false)

function select(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) {
    return
  }

  if (!disabled) {
    emit('add', Array.from(event.target.files ?? []))
  }

  event.target.value = ''
}

function drop(event: DragEvent) {
  dragging.value = false

  if (!disabled) {
    emit('add', Array.from(event.dataTransfer?.files ?? []))
  }
}
</script>

<template>
  <button
    type="button"
    aria-label="Seleccionar archivos"
    aria-describedby="accepted-file-types"
    :disabled="disabled"
    class="flex min-h-[202px] w-full cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-4 py-5 text-center transition-colors enabled:hover:border-primary enabled:hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-44 sm:px-5 sm:py-6 motion-reduce:transition-none"
    :class="
      dragging
        ? 'border-primary bg-primary-soft'
        : 'border-primary/35 bg-primary-soft/30'
    "
    @click="input?.click()"
    @dragover.prevent="dragging = !disabled"
    @dragleave.self.prevent="dragging = false"
    @drop.prevent="drop"
  >
    <span
      class="grid size-12 shrink-0 place-items-center rounded-xl border border-line bg-surface text-primary"
    >
      <Upload
        :size="24"
        aria-hidden="true"
      />
    </span>
    <span class="min-w-0">
      <span class="block text-sm font-semibold text-ink">
        Haz clic o arrastra tus archivos aquí
      </span>
      <span
        id="accepted-file-types"
        class="mt-1 block text-xs text-ink-muted"
      >
        Archivos XML o ZIP
      </span>
    </span>
  </button>
  <input
    ref="fileInput"
    class="sr-only"
    type="file"
    tabindex="-1"
    aria-label="Archivos XML o ZIP"
    :disabled="disabled"
    multiple
    accept=".xml,.zip"
    @change="select"
  />
</template>
