<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, ShieldCheck } from 'lucide-vue-next'

import { InvoiceSnapshotKind } from '../../invoices/domain/invoiceSnapshot'
import { ActivityOperation, ActivityPhase } from '../model/activity'
import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import { RouteName } from '../../../app/router/routeNames'
import { useStorageLimits } from '../../../app/config/storageLimits'
import Button from '../../../shared/ui/button/Button.vue'
import { useInvoiceStore } from '../../invoices/stores/useInvoiceStore'
import FirstInvoiceCelebration from '../../invoices/components/FirstInvoiceCelebration.vue'
import BatchActivityPanel from '../components/BatchActivityPanel.vue'
import FileDropzone from '../components/FileDropzone.vue'
import ProcessingResults from '../components/ProcessingResults.vue'
import SelectedFileList from '../components/SelectedFileList.vue'
import { useFileSelection } from '../composables/useFileSelection'
import { useUploadProcessing } from '../composables/useUploadProcessing'
import { formatBytes, reconcileSelection } from '../model/selection'
import { useProcessingService } from '../services/processingService'
import { useProcessingAvailability } from '../stores/useProcessingAvailability'
import { useLeaveProtection } from '../../../app/composables/useLeaveProtection'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

const limits = useStorageLimits()
const service = useProcessingService()
const availability = useProcessingAvailability()
const invoices = useInvoiceStore()
const router = useRouter()
const interaction = useUpdateInteraction()
const storageReady = computed(
  () => invoices.snapshot.kind === InvoiceSnapshotKind.Ready,
)

const selection = useFileSelection(limits, () =>
  invoices.snapshot.kind === InvoiceSnapshotKind.Ready
    ? {
        ready: true,
        files: invoices.snapshot.usage.files,
        sourceIds: invoices.snapshot.sourceIds,
        sourceNames: invoices.snapshot.sourceNames,
      }
    : { ready: false },
)

const latestOperation = shallowRef<
  typeof ActivityOperation.Selection | typeof ActivityOperation.Processing
>(ActivityOperation.Selection)
const selectionFeedbackKey = shallowRef(0)
const selectionBatchBytes = shallowRef<number>()
const selectionExpanded = shallowRef(false)
const resultsExpanded = shallowRef(false)
const validationNotice = shallowRef<string>()
const celebrate = shallowRef(false)

let celebrationTimer: ReturnType<typeof setTimeout> | undefined
let beforeEmpty = false

const processing = useUploadProcessing(service, {
  publish: invoices.publish,

  reconcileSelection(results, notStarted) {
    selection.replace(
      reconcileSelection(selection.files.value, results, notStarted),
    )
  },

  finished(saved) {
    if (invoices.claimFirstCelebration(beforeEmpty, saved)) {
      celebrate.value = true
      clearTimeout(celebrationTimer)
      celebrationTimer = setTimeout(() => {
        celebrate.value = false
      }, 4000)
    }
  },
})

const busy = computed(() => selection.busy.value || processing.busy.value)
const controlsBlocked = computed(
  () => busy.value || Boolean(interaction?.blocked.value),
)
const activity = computed(() => {
  const current =
    latestOperation.value === ActivityOperation.Selection
      ? selection.activity.value
      : processing.activity.value

  if (!validationNotice.value) {
    return current
  }

  return {
    ...current,
    phase: ActivityPhase.Failed,
    tone: FeedbackTone.Warning,
    completed: 0,
    total: 0,
    message: validationNotice.value,
  }
})
// Solo se reinicia la barra para conservar el panel y sus avisos de progreso
// para los lectores de pantalla.

const activityProgressKey = computed(() =>
  latestOperation.value === ActivityOperation.Selection
    ? `selection:${selectionFeedbackKey.value}`
    : `processing:${processing.attemptId.value}`,
)

const invoicesAvailable = computed(
  () =>
    invoices.snapshot.kind === InvoiceSnapshotKind.Ready &&
    invoices.snapshot.invoices.length > 0,
)

const selectionSizeLabel = computed(() =>
  selectionBatchBytes.value === undefined
    ? undefined
    : formatBytes(selectionBatchBytes.value),
)

const unregister = useLeaveProtection().register({
  isBlocked: () => busy.value,

  isUpdateBlocked: () => busy.value || selection.unresolved.value,

  isDirty: () => false,

  confirmDiscard: async () => true,

  commitLeave() {
    selectionExpanded.value = false
    resultsExpanded.value = false

    selection.clear()
    processing.clear()

    celebrate.value = false
    clearTimeout(celebrationTimer)
  },
})

onBeforeUnmount(() => {
  unregister()
  clearTimeout(celebrationTimer)
})

async function add(files: File[]) {
  if (controlsBlocked.value) {
    return
  }

  latestOperation.value = ActivityOperation.Selection
  selectionFeedbackKey.value += 1
  validationNotice.value = undefined

  const adding = selection.add(files)

  if (selection.activity.value.phase === ActivityPhase.Loading) {
    selectionExpanded.value = true
    resultsExpanded.value = false
    selectionBatchBytes.value = files.reduce(
      (total, file) => total + file.size,
      0,
    )
  } else if (selection.activity.value.phase === ActivityPhase.Failed) {
    selectionBatchBytes.value = undefined
  }

  await adding
}

function remove(id: string) {
  if (controlsBlocked.value) {
    return
  }

  selection.remove(id)
  validationNotice.value = undefined
}

async function process() {
  if (
    controlsBlocked.value ||
    selection.unresolved.value ||
    !selection.files.value.length
  ) {
    return
  }

  const valid = selection.validate()

  if (!valid.ok) {
    validationNotice.value = valid.message

    return
  }

  latestOperation.value = ActivityOperation.Processing
  selectionExpanded.value = false
  resultsExpanded.value = true
  validationNotice.value = undefined
  beforeEmpty =
    invoices.snapshot.kind === InvoiceSnapshotKind.Ready &&
    invoices.snapshot.invoices.length === 0

  await processing.start(selection.files.value)
}

let previousStoredFiles: number | undefined

watch(
  () =>
    invoices.snapshot.kind === InvoiceSnapshotKind.Ready
      ? invoices.snapshot.usage.files
      : undefined,
  (files) => {
    if (files === undefined) {
      return
    }

    const emptied =
      previousStoredFiles !== undefined &&
      previousStoredFiles > 0 &&
      files === 0

    previousStoredFiles = files

    if (!emptied) {
      return
    }

    processing.clear()
    latestOperation.value = ActivityOperation.Processing
    validationNotice.value = undefined

    celebrate.value = false
    clearTimeout(celebrationTimer)
  },
  { immediate: true },
)
</script>

<template>
  <section
    class="mx-auto grid w-full max-w-280 gap-6 rounded-2xl border border-line bg-surface p-5 sm:gap-8 sm:p-6"
  >
    <section
      aria-labelledby="upload-page-heading"
      class="grid gap-5 rounded-xl border border-line p-4 sm:p-5"
    >
      <header>
        <h1
          id="upload-page-heading"
          class="text-[28px] font-semibold tracking-tight text-ink"
        >
          Cargar facturas
        </h1>
        <p class="mt-2 text-sm text-ink-muted">
          Carga tus archivos para empezar a clasificarlos.
        </p>
      </header>
      <FileDropzone
        :disabled="
          !storageReady || controlsBlocked || selection.unresolved.value
        "
        @add="add"
      />
    </section>
    <section
      aria-labelledby="upload-state-heading"
      class="grid min-w-0 gap-5 rounded-xl border border-line bg-surface p-4 sm:p-5"
    >
      <h2
        id="upload-state-heading"
        class="border-b border-line pb-4 text-lg font-semibold text-ink"
      >
        Estado de la carga
      </h2>
      <BatchActivityPanel
        :activity="activity"
        :selection-size="selectionSizeLabel"
        :progress-key="activityProgressKey"
        :can-cancel="selection.busy.value || processing.canCancel.value"
        @cancel="
          selection.busy.value ? selection.cancel() : processing.cancel()
        "
      />
      <section
        aria-label="Importación de archivos"
        :aria-busy="busy"
        class="grid min-w-0 gap-5"
      >
        <SelectedFileList
          v-model:open="selectionExpanded"
          :files="selection.files.value"
          :disabled="controlsBlocked"
          @remove="remove"
        />
        <ProcessingResults
          v-model:open="resultsExpanded"
          :results="processing.results.value"
          :summary="processing.confirmedSummary.value"
          :attempt-id="processing.attemptId.value"
        />
        <p
          v-if="selection.unresolved.value"
          role="alert"
          class="rounded-xl border border-warning/30 bg-warning/10 px-4 py-4 text-sm text-ink"
        >
          No pudimos confirmar el resultado de algunos archivos. Revisa su
          estado antes de volver a procesarlos. No se reintentarán
          automáticamente.
        </p>
        <footer
          class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="flex items-start gap-2 text-xs leading-5 text-ink-muted">
            <ShieldCheck
              class="mt-0.5 shrink-0"
              :size="15"
              aria-hidden="true"
            />
            Tus archivos se procesan de forma local en tu dispositivo.
          </p>

          <div class="flex flex-col gap-3 sm:flex-row">
            <Button
              class="h-10 w-full gap-2 px-4 sm:w-auto"
              :disabled="
                !storageReady ||
                !availability.available ||
                !selection.files.value.length ||
                controlsBlocked ||
                selection.unresolved.value
              "
              @click="process"
            >
              Procesar archivos
              <ArrowRight
                :size="16"
                aria-hidden="true"
              />
            </Button>
            <Button
              v-if="processing.outcome.value && invoicesAvailable"
              variant="success"
              class="h-10 w-full gap-2 px-4 sm:w-auto motion-safe:animate-pulse"
              :disabled="controlsBlocked"
              @click="router.push({ name: RouteName.Invoices })"
            >
              Ver mis facturas
              <ArrowRight
                :size="18"
                aria-hidden="true"
              />
            </Button>
          </div>
        </footer>
      </section>
    </section>

    <FirstInvoiceCelebration v-if="celebrate" />
  </section>
</template>
