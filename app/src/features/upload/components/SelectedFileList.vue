<script setup lang="ts">
import { AlertCircle, Clock3, FileArchive, FileText, X } from 'lucide-vue-next'
import AnimatedScrollList from '../../../shared/ui/AnimatedScrollList.vue'
import Button from '../../../shared/ui/button/Button.vue'
import { formatBytes, type SelectedFile } from '../model/selection'

const { files, disabled = false } = defineProps<{
  files: readonly SelectedFile[]
  disabled?: boolean
}>()
const emit = defineEmits<{ remove: [id: string] }>()
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <AnimatedScrollList
    v-model:open="open"
    label="Archivos seleccionados"
    :count="files.length"
    :keys="files.map((entry) => entry.id)"
  >
    <template
      v-if="files.length"
      #columns
    >
      <div
        class="hidden h-[33px] grid-cols-[1.5rem_minmax(0,1fr)_6.5rem_8.5rem_2rem] gap-3 border-b border-line bg-table-head px-4 py-2 text-xs font-semibold leading-4 text-ink-muted sm:grid"
        aria-hidden="true"
      >
        <span class="col-span-2">Archivo</span>
        <span class="text-right">Tamaño</span>
        <span>Estado</span>
        <span class="sr-only">Retirar</span>
      </div>
    </template>
    <p
      v-if="!files.length"
      class="px-4 py-3 text-sm leading-5 text-ink-muted"
    >
      Aún no has seleccionado archivos.
    </p>
    <ul
      v-else
      class="divide-y divide-line"
    >
      <li
        v-for="entry in files"
        :key="entry.id"
        :data-row-key="entry.id"
        class="grid min-h-[var(--file-list-row-height)] grid-cols-[1.5rem_minmax(0,1fr)_2rem] items-center gap-x-3 px-4 py-2 sm:grid-cols-[1.5rem_minmax(0,1fr)_6.5rem_8.5rem_2rem]"
      >
        <span
          class="col-start-1 row-span-2 row-start-1 grid size-6 place-items-center text-primary sm:row-span-1"
        >
          <component
            :is="/\.zip$/i.test(entry.file.name) ? FileArchive : FileText"
            class="size-6"
            :size="24"
            aria-hidden="true"
          />
        </span>
        <div class="col-start-2 row-start-1 min-w-0">
          <p class="break-all text-sm font-medium text-ink">
            {{ entry.file.name }}
          </p>
          <p
            v-if="entry.unresolved"
            class="mt-1 text-sm text-danger"
          >
            Resultado sin confirmar. Revisa su estado antes de volver a
            procesarlo.
          </p>
          <p
            v-else-if="entry.failure"
            class="mt-1 break-words text-sm text-danger"
          >
            {{ entry.failure }}
          </p>
        </div>
        <span
          class="hidden text-right text-sm tabular-nums text-ink-muted sm:col-start-3 sm:row-start-1 sm:block"
        >
          {{ formatBytes(entry.file.size) }}
        </span>
        <div
          class="col-start-2 row-start-2 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:contents"
        >
          <span class="text-xs tabular-nums text-ink-muted sm:hidden">
            {{ formatBytes(entry.file.size) }}
          </span>
          <span
            class="inline-flex items-center justify-self-start gap-1.5 rounded-md px-2 py-1 text-xs font-medium sm:col-start-4 sm:row-start-1"
            :class="
              entry.unresolved || entry.failure
                ? 'bg-danger/5 text-danger'
                : 'bg-canvas text-ink-muted'
            "
          >
            <component
              :is="entry.unresolved || entry.failure ? AlertCircle : Clock3"
              :size="12"
              aria-hidden="true"
            />
            {{
              entry.unresolved
                ? 'Sin confirmar'
                : entry.failure
                  ? 'Con error'
                  : 'Pendiente'
            }}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          class="col-start-3 row-span-2 row-start-1 size-8 shrink-0 text-ink-muted hover:bg-danger/10 hover:text-danger sm:col-start-5 sm:row-span-1"
          :disabled="disabled"
          :aria-label="`Retirar ${entry.file.name}`"
          @click="emit('remove', entry.id)"
        >
          <X
            :size="18"
            aria-hidden="true"
          />
        </Button>
      </li>
    </ul>
  </AnimatedScrollList>
</template>
