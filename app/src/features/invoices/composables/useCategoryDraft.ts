import { computed, onScopeDispose, shallowRef } from 'vue'
import { toast } from 'vue-sonner'

import { SelectionMode } from '../domain/classificationModel'
import { StorageErrorCode } from '../domain/storageErrors'
import {
  categoryToCanonical,
  isCategory,
  type Category,
} from '../domain/categoryModel'
import type { Invoice } from '../domain/invoiceModel'
import type { InvoiceData } from '../domain/storageModel'
import { useInvoiceService } from '../services/invoiceService'
import { useInvoiceStore } from '../stores/useInvoiceStore'
import type { Result } from '../../../shared/lib/result'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

export interface CategoryDraft {
  invoiceId: string
  conceptId?: string
  category: Category
  baseCategory: Category
  automatic: boolean
  revision: number
  stale?: boolean
  error?: string
}

export function useCategoryDraft(isInteractionBlocked: () => boolean) {
  const service = useInvoiceService()
  const store = useInvoiceStore()
  const interaction = useUpdateInteraction()

  const draft = shallowRef<CategoryDraft | null>(null)
  const saving = shallowRef(false)
  const locked = computed(
    () =>
      saving.value ||
      isInteractionBlocked() ||
      Boolean(interaction?.blocked.value),
  )
  let alive = true

  onScopeDispose(() => {
    alive = false
  })

  function isEditing(invoiceId: string, conceptId?: string) {
    return (
      draft.value?.invoiceId === invoiceId &&
      draft.value.conceptId === conceptId
    )
  }

  function begin(invoice: Invoice, conceptId?: string, automatic = false) {
    if (locked.value || draft.value) {
      return
    }

    const concept = invoice.concepts.find((item) => item.id === conceptId)
    const current = conceptId ? concept?.category : invoice.principal
    const original = conceptId ? concept?.original : invoice.originalPrincipal

    const manual = conceptId
      ? concept?.selectionMode === SelectionMode.Manual
      : invoice.principalMode === SelectionMode.Manual

    if (!current || (automatic && !manual)) {
      return
    }

    draft.value = {
      invoiceId: invoice.id,
      conceptId,
      category: automatic && original ? original : current,
      baseCategory: current,
      automatic,
      revision: invoice.revision,
    }

    if (automatic) {
      void save()
    }
  }

  function change(value: string) {
    if (!draft.value || locked.value || !isCategory(value)) {
      return
    }

    draft.value = {
      ...draft.value,
      category: value,
      automatic: false,
      error: draft.value.stale ? draft.value.error : undefined,
    }
  }

  function discard() {
    if (!saving.value) {
      draft.value = null
    }
  }

  function cancel() {
    if (!locked.value) {
      discard()
    }
  }

  async function save() {
    const value = draft.value

    if (!value || locked.value || !alive || value.stale) {
      return
    }

    saving.value = true
    store.invalidateReads()

    try {
      let result: Result<InvoiceData>

      if (value.conceptId) {
        result = await service.correct({
          invoiceId: value.invoiceId,
          conceptId: value.conceptId,
          selection: value.automatic
            ? { mode: SelectionMode.Model }
            : {
                mode: SelectionMode.Manual,
                category: categoryToCanonical(value.category),
              },
          expectedRevision: value.revision,
        })
      } else {
        result = await service.correctInvoiceCategory({
          invoiceId: value.invoiceId,
          selection: value.automatic
            ? { mode: SelectionMode.Automatic }
            : {
                mode: SelectionMode.Manual,
                category: categoryToCanonical(value.category),
              },
          expectedRevision: value.revision,
        })
      }

      if (!alive) {
        return
      }

      if (result.ok) {
        store.publish(result.value)
        draft.value = null

        if (value.automatic) {
          toast.success(
            value.conceptId
              ? 'Categoría del modelo restaurada.'
              : 'Modo automático restaurado.',
          )
        } else {
          toast.success('Categoría guardada.')
        }
      } else {
        const stale = result.code === StorageErrorCode.Conflict

        if (stale) {
          await store.refresh()
        }

        if (!alive) {
          return
        }

        draft.value = {
          ...value,
          stale,
          error: stale
            ? `${result.message} La vista se actualizó. Cancela esta edición y vuelve a abrirla para guardar la revisión actual.`
            : result.message || 'No se pudo guardar. Inténtalo de nuevo.',
        }

        toast.error(draft.value.error ?? 'No se pudo guardar.')
      }
    } catch {
      if (alive) {
        draft.value = {
          ...value,
          error: 'No se pudo guardar. Inténtalo de nuevo.',
        }

        toast.error(draft.value.error ?? 'No se pudo guardar.')
      }
    } finally {
      if (alive) {
        saving.value = false
      }
    }
  }

  return {
    draft,
    saving,
    locked,
    begin,
    change,
    save,
    cancel,
    discard,
    isEditing,
  }
}

export type CategoryEditing = ReturnType<typeof useCategoryDraft>
