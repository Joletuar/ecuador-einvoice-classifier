import { inject, provide, type InjectionKey } from 'vue'
import type { CategoryEditing } from './useCategoryDraft'

const categoryEditingKey: InjectionKey<CategoryEditing> =
  Symbol('categoryEditing')

export function provideCategoryEditing(editing: CategoryEditing) {
  provide(categoryEditingKey, editing)
}

export function useCategoryEditing(): CategoryEditing {
  const editing = inject(categoryEditingKey)

  if (!editing) {
    throw new Error('Invoice category editing must be provided.')
  }

  return editing
}
