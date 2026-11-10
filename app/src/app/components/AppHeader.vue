<script setup lang="ts">
import { ReceiptText } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'

import { RouteName } from '../router/routeNames'

withDefaults(defineProps<{ invoicesAvailable?: boolean }>(), {
  invoicesAvailable: false,
})

const navigationClass =
  'flex min-h-11 min-w-0 items-center justify-center px-2 py-2 text-sm font-semibold text-ink-muted transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-0 sm:px-3 motion-reduce:transition-none'
</script>

<template>
  <header class="border-b border-line bg-surface">
    <div
      class="mx-auto flex w-full max-w-292 flex-wrap items-center gap-x-2 gap-y-2 px-6 py-3 sm:gap-x-5 sm:gap-y-3 sm:py-4"
    >
      <RouterLink
        :to="{ name: RouteName.Upload }"
        aria-label="Mis facturas, inicio"
        class="mr-auto inline-flex min-h-11 items-center gap-2 text-base font-extrabold text-ink sm:min-h-0"
      >
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white"
        >
          <ReceiptText
            :size="18"
            aria-hidden="true"
          />
        </span>
        <span>Mis facturas</span>
      </RouterLink>
      <nav
        aria-label="Navegación principal"
        class="order-3 flex w-full justify-center gap-2 sm:order-none sm:w-auto"
      >
        <RouterLink
          :to="{ name: RouteName.Upload }"
          :class="navigationClass"
          active-class="underline underline-offset-8 decoration-2 text-primary"
        >
          Cargar
        </RouterLink>
        <button
          v-if="!invoicesAvailable"
          type="button"
          disabled
          :class="navigationClass"
          class="cursor-not-allowed opacity-50"
          title="Disponible cuando haya facturas guardadas"
        >
          Facturas
        </button>
        <RouterLink
          v-else
          :to="{ name: RouteName.Invoices }"
          :class="navigationClass"
          active-class="underline underline-offset-8 decoration-2 text-primary"
        >
          Facturas
        </RouterLink>
        <RouterLink
          :to="{ name: RouteName.Information }"
          :class="navigationClass"
          active-class="underline underline-offset-8 decoration-2 text-primary"
        >
          Información
        </RouterLink>
      </nav>
      <div
        class="ml-auto flex shrink-0 items-center justify-end gap-1 sm:max-w-full sm:gap-2"
      >
        <slot name="storage" />
        <slot name="offline" />
      </div>
    </div>
  </header>
</template>
