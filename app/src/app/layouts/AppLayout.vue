<script setup lang="ts">
import 'vue-sonner/style.css'
import { RouterView } from 'vue-router'
import { Toaster, toast } from 'vue-sonner'

import AppHeader from '../components/AppHeader.vue'
import OfflineMenu from '../../features/offline/components/OfflineMenu.vue'
import StoredDataMenu from '../../features/invoices/containers/StoredDataMenu.vue'
import { useOfflineStatus } from '../../features/offline/composables/useOfflineStatus'
import { useInvoiceStore } from '../../features/invoices/stores/useInvoiceStore'
import { useLeaveProtection } from '../composables/useLeaveProtection.js'
import { useUpdateInteraction } from '../updateCoordinator'

const invoices = useInvoiceStore()
const protection = useLeaveProtection()
const interaction = useUpdateInteraction()

const { status, canRetry, retrying, retry, applyUpdate } = useOfflineStatus()

async function updateInterface() {
  try {
    await applyUpdate(protection.prepareLeave)
  } catch {
    toast.error('No se pudo actualizar la interfaz.')
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <AppHeader :invoices-available="invoices.hasInvoices">
      <template #storage><StoredDataMenu /></template>
      <template #offline>
        <OfflineMenu
          :view="status"
          :can-retry="canRetry"
          :retrying="retrying"
          @retry="retry()"
          @update="updateInterface"
        />
      </template>
    </AppHeader>
    <main class="mx-auto w-full max-w-292 flex-1 px-6 py-8">
      <div :inert="interaction?.blocked.value || undefined"><RouterView /></div>
    </main>
    <footer class="px-4 pb-8 text-center text-sm text-ink-muted">
      © {{ new Date().getFullYear() }} Mis facturas. Todos los derechos
      reservados.
    </footer>
    <Toaster
      position="top-right"
      :rich-colors="true"
      container-aria-label="Notificaciones"
      class="pointer-events-auto! z-110! font-sans!"
    />
  </div>
</template>
