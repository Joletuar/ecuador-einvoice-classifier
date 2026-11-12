<script setup lang="ts">
import type { CategorySummaryView } from '../presentation/invoiceListPresenter'
import { categoryVisual } from './categoryVisuals'

defineProps<{
  cards: CategorySummaryView[]
}>()
</script>

<template>
  <section
    class="grid gap-2 border-b border-line pb-6"
    aria-labelledby="summary-heading"
  >
    <h2
      id="summary-heading"
      class="text-lg font-semibold"
    >
      Resumen por categoría
    </h2>
    <p class="text-xs text-ink-muted">
      Breve detalle de los gastos por categoría.
    </p>
    <ul
      class="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 xl:grid-cols-4"
    >
      <li
        v-for="card in cards"
        :key="card.category"
        class="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 p-4 inset-ring inset-ring-current/10"
        :class="[
          categoryVisual(card.category).classes,
          !card.hasAssociations &&
            'bg-[color-mix(in_srgb,currentColor_3%,white)]!',
        ]"
      >
        <component
          :is="categoryVisual(card.category).icon"
          :size="32"
          class="shrink-0"
          :class="!card.hasAssociations && 'text-current/95'"
          aria-hidden="true"
        />
        <dl class="grid min-w-0 content-start gap-2">
          <dt
            class="text-xs font-medium"
            :class="!card.hasAssociations && 'text-current/95'"
          >
            {{ card.label }}
          </dt>
          <dd
            class="whitespace-nowrap text-lg tabular-nums"
            :class="
              card.hasAssociations
                ? 'font-semibold'
                : 'font-normal text-current/95'
            "
          >
            {{ card.amountLabel }}
          </dd>
          <dd
            v-if="card.hasAssociations"
            class="text-xs text-ink-muted"
          >
            <span class="block">
              {{ card.invoiceCount }}
              {{ card.invoiceCount === 1 ? 'factura' : 'facturas' }}
            </span>
            <span class="block">
              {{ card.conceptCount }}
              {{ card.conceptCount === 1 ? 'concepto' : 'conceptos' }}
            </span>
          </dd>
          <dd
            v-else
            class="text-xs text-current/95"
          >
            Sin gastos en esta categoría
          </dd>
        </dl>
      </li>
    </ul>
  </section>
</template>
