<script setup lang="ts">
import { animate, stagger } from 'motion'
import { ChevronDown } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    keys: string[]
    count?: number
    normalRowHeight?: number
    mobileRowHeight?: number
  }>(),
  { count: undefined, normalRowHeight: 52, mobileRowHeight: 65 },
)
const expanded = defineModel<boolean>('open', { default: false })

const viewport = ref<HTMLElement>()

const maximumAnimatedRows = 20

let controls: { cancel: () => void }[] = []
let generation = 0

function toggle(event: Event) {
  if (!(event.currentTarget instanceof HTMLDetailsElement)) {
    return
  }

  expanded.value = event.currentTarget.open
}

function cancel() {
  generation++
  controls.forEach((control) => control.cancel())
  controls = []
}

async function enter(previous: string[]) {
  cancel()

  const token = generation

  await nextTick()

  const el = viewport.value

  if (!el || token !== generation) {
    return
  }

  const previousKeys = new Set(previous)
  const added = new Set(props.keys.filter((key) => !previousKeys.has(key)))
  const rows = Array.from(
    el.querySelectorAll<HTMLElement>('[data-row-key]'),
  ).filter((row) => added.has(row.dataset.rowKey!))

  if (!rows.length) {
    return
  }

  const reduced = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches

  if (reduced) {
    return
  }

  // Se limita la animación a las filas recientes para que un lote grande no
  // bloquee la pantalla. Las demás filas siguen disponibles.
  const animatedRows = rows.slice(-maximumAnimatedRows)
  const step = Math.min(0.06, 0.6 / Math.max(1, animatedRows.length - 1))

  controls.push(
    animate(
      animatedRows,
      { opacity: [0.35, 1], transform: ['translateY(6px)', 'translateY(0px)'] },
      { duration: 0.2, delay: stagger(step), ease: 'easeOut' },
    ),
  )
}

onMounted(() => {
  void enter([])
})

watch(
  () => props.keys,
  (keys, old) => {
    if (!keys.length) {
      cancel()

      return
    }

    if (keys.join('\0') !== old.join('\0')) {
      void enter(old)
    }
  },
)

onBeforeUnmount(cancel)
</script>

<template>
  <details
    :open="expanded"
    :style="{
      '--file-list-desktop-row-height': `${props.normalRowHeight}px`,
      '--file-list-mobile-row-height': `${props.mobileRowHeight}px`,
    }"
    class="group/file-list min-w-0 overflow-hidden rounded-xl border border-line bg-surface [--file-list-row-height:var(--file-list-mobile-row-height)] sm:[--file-list-row-height:var(--file-list-desktop-row-height)]"
    @toggle="toggle"
  >
    <summary
      class="relative cursor-pointer list-none border-b border-transparent bg-primary-soft px-4 py-3 text-ink outline-offset-[-3px] hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary group-open/file-list:border-line [&::-webkit-details-marker]:hidden"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2
          class="min-w-0 text-sm font-semibold"
          :class="$slots['header-detail'] ? 'pr-7 sm:pr-0' : 'flex-1 pr-7'"
        >
          <span>
            {{ label }}
            <template v-if="count !== undefined">({{ count }})</template>
          </span>
        </h2>
        <div
          v-if="$slots['header-detail']"
          class="w-full sm:ml-auto sm:w-auto sm:pr-7"
        >
          <slot name="header-detail" />
        </div>
      </div>
      <ChevronDown
        :size="18"
        class="absolute right-4 top-3.5 shrink-0 transition-transform group-open/file-list:rotate-180 motion-reduce:transition-none"
        aria-hidden="true"
      />
    </summary>
    <slot name="columns" />
    <div
      ref="viewport"
      class="relative max-h-[calc(var(--file-list-row-height)*5)] min-h-0 overflow-y-auto overscroll-auto focus-visible:outline-2 focus-visible:outline-primary"
      role="region"
      :aria-label="label"
      tabindex="0"
    >
      <slot />
    </div>
  </details>
</template>
