import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { defineComponent, h, shallowRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CategoryEditor from '../src/features/invoices/components/CategoryEditor.vue'
import CategoryActions from '../src/features/invoices/components/CategoryActions.vue'
import { useCategoryDraft } from '../src/features/invoices/composables/useCategoryDraft'
import { useInvoiceStore } from '../src/features/invoices/stores/useInvoiceStore'
import {
  invoiceServiceKey,
  type InvoiceService,
} from '../src/features/invoices/services/invoiceService'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import type { Result } from '../src/shared/lib/result'
import { invoiceFixture, invoiceDataFixture } from './fixtures/invoices'
import {
  updateInteractionKey,
  type UpdateInteraction,
} from '../src/app/updateCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

function mountEditor(service: InvoiceService, interaction?: UpdateInteraction) {
  const pinia = createPinia()
  const Host = defineComponent({
    setup() {
      const invoice = invoiceFixture()
      const store = useInvoiceStore()

      store.publish(invoiceDataFixture([invoice]))

      const editing = useCategoryDraft(() => false)

      return () =>
        h('section', [
          h(
            'button',
            { onClick: () => editing.begin(invoice, 'concept-1') },
            'Editar concepto',
          ),
          h(CategoryEditor, {
            label: 'Fruta',
            category: 'Alimentación',
            active: !!editing.draft.value,
            draft: editing.draft.value?.category ?? 'Alimentación',
            baseCategory: editing.draft.value?.baseCategory,
            saving: editing.locked.value,
            error: editing.draft.value?.error,
            stale: editing.draft.value?.stale,
            onChange: editing.change,
            onSave: editing.save,
            onCancel: editing.cancel,
          }),
          h(
            'output',
            store.snapshot.kind === 'ready'
              ? `Guardada: ${store.snapshot.invoices[0]?.concepts[0]?.category}`
              : 'No disponible',
          ),
        ])
    },
  })
  const wrapper = mount(Host, {
    global: {
      plugins: [pinia],
      provide: {
        [invoiceServiceKey]: service,
        ...(interaction ? { [updateInteractionKey]: interaction } : {}),
      },
    },
  })

  return { wrapper, store: useInvoiceStore(pinia) }
}

describe('category editing interface', () => {
  it('blocks draft creation and mutation events during tab admission and restores the same draft after abort', async () => {
    const blocked = shallowRef(true)
    const correct = vi.fn<InvoiceService['correct']>(() => ({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    }))
    const { wrapper } = mountEditor(
      { ...createUnavailableInvoiceService(), correct },
      { blocked, message: shallowRef(undefined) },
    )

    await wrapper.get('button').trigger('click')

    expect(wrapper.find('select').exists()).toBe(false)
    blocked.value = false

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')

    blocked.value = true

    await flushPromises()

    const editor = wrapper.getComponent(CategoryEditor)

    editor.vm.$emit('save')
    editor.vm.$emit('cancel')
    editor.vm.$emit('change', 'Vivienda')

    await flushPromises()

    expect(correct).not.toHaveBeenCalled()
    expect(wrapper.get('select').element.value).toBe('Salud')
    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
    blocked.value = false

    await flushPromises()

    expect(wrapper.get('select').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('select').element.value).toBe('Salud')
    wrapper.unmount()
  })
  it('refreshes a stale snapshot on conflict and preserves the draft without rebasing its revision', async () => {
    const latest = invoiceFixture({
      issuer: 'Actualizado por otra pestaña',
      revision: 2,
    })
    const read = vi.fn<InvoiceService['read']>(() => ({
      ok: true,
      value: invoiceDataFixture([latest]),
    }))
    const correct = vi.fn<InvoiceService['correct']>(() => ({
      ok: false,
      code: 'storage-conflict',
      message: 'La factura cambió en otra pestaña.',
    }))
    const { wrapper, store } = mountEditor({
      ...createUnavailableInvoiceService(),
      read,
      correct,
    })

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')
    await wrapper
      .get('button[aria-label="Guardar cambios de Fruta"]')
      .trigger('click')
    await flushPromises()

    expect(read).toHaveBeenCalledTimes(1)
    expect(store.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [{ issuer: latest.issuer, revision: 2 }],
    })
    expect(wrapper.get('select').element.value).toBe('Salud')
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Cancela esta edición',
    )
    expect(
      wrapper
        .get('button[aria-label="Guardar cambios de Fruta"]')
        .attributes('disabled'),
    ).toBeDefined()
    expect(correct).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      conceptId: 'concept-1',
      expectedRevision: 1,
      selection: { mode: 'manual', category: 'Salud' },
    })
    wrapper.unmount()
  })

  it('allows an explicit manual selection that matches the current label', async () => {
    const wrapper = mount(CategoryEditor, {
      props: {
        label: 'Fruta',
        category: 'Alimentación',
        active: true,
        draft: 'Alimentación',
        baseCategory: 'Alimentación',
        saving: false,
      },
    })

    expect(
      wrapper
        .get('button[aria-label="Guardar cambios de Fruta"]')
        .attributes('disabled'),
    ).toBeUndefined()

    await wrapper.setProps({ draft: 'Salud' })
    await wrapper
      .get('button[aria-label="Guardar cambios de Fruta"]')
      .trigger('click')

    expect(wrapper.emitted('save')).toEqual([[]])
    wrapper.unmount()
  })

  it('uses selection mode to allow restoration even when manual and original labels match', () => {
    const wrapper = mount(CategoryActions, {
      props: {
        label: 'Fruta',
        category: 'Alimentación',
        original: 'Alimentación',
        manual: true,
        disabled: false,
      },
    })

    expect(
      wrapper
        .get('button[aria-label="Restaurar categoría original de Fruta"]')
        .attributes('disabled'),
    ).toBeUndefined()
    wrapper.unmount()
  })

  it('retains the draft and existing snapshot after a rejected correction', async () => {
    const correct = vi.fn<InvoiceService['correct']>(() => ({
      ok: false,
      code: 'storage-write-failed',
      message: 'No se pudo escribir. Revisa la corrección.',
    }))
    const { wrapper, store } = mountEditor({
      ...createUnavailableInvoiceService(),
      correct,
    })

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')
    await wrapper
      .get('button[aria-label="Guardar cambios de Fruta"]')
      .trigger('click')
    await flushPromises()

    expect(correct).toHaveBeenCalledWith({
      invoiceId: 'invoice-1',
      conceptId: 'concept-1',
      selection: { mode: 'manual', category: 'Salud' },
      expectedRevision: 1,
    })
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'No se pudo escribir',
    )
    expect(wrapper.get('select').element.value).toBe('Salud')
    expect(store.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [
        { concepts: [{ category: 'Alimentación' }, { category: 'Salud' }] },
      ],
    })
    wrapper.unmount()
  })

  it('blocks editing while saving and publishes only the successful authoritative snapshot', async () => {
    const pending = deferred<Result<InvoiceData>>()
    const { wrapper } = mountEditor({
      ...createUnavailableInvoiceService(),

      correct: () => pending.promise,
    })

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')
    await wrapper
      .get('button[aria-label="Guardar cambios de Fruta"]')
      .trigger('click')

    expect(wrapper.get('select').attributes('disabled')).toBeDefined()
    expect(
      wrapper
        .get('button[aria-label="Cancelar edición de Fruta"]')
        .attributes('disabled'),
    ).toBeDefined()

    const changed = invoiceFixture()

    changed.concepts[0]!.category = 'Salud'
    pending.resolve({ ok: true, value: invoiceDataFixture([changed]) })

    await flushPromises()

    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('output').text()).toBe('Guardada: Salud')
    wrapper.unmount()
  })

  it('cancels a local draft without calling the service', async () => {
    const correct = vi.fn<InvoiceService['correct']>(() => ({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    }))
    const { wrapper } = mountEditor({
      ...createUnavailableInvoiceService(),
      correct,
    })

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')
    await wrapper
      .get('button[aria-label="Cancelar edición de Fruta"]')
      .trigger('click')

    expect(wrapper.find('select').exists()).toBe(false)
    expect(correct).not.toHaveBeenCalled()
    expect(wrapper.get('output').text()).toBe('Guardada: Alimentación')
    wrapper.unmount()
  })

  it('ignores a mutation response after its owning editor was disposed', async () => {
    const pending = deferred<Result<InvoiceData>>()
    const { wrapper, store } = mountEditor({
      ...createUnavailableInvoiceService(),

      correct: () => pending.promise,
    })

    await wrapper.get('button').trigger('click')
    await wrapper.get('select').setValue('Salud')
    await wrapper
      .get('button[aria-label="Guardar cambios de Fruta"]')
      .trigger('click')

    wrapper.unmount()
    pending.resolve({ ok: true, value: invoiceDataFixture([]) })

    await flushPromises()

    expect(store.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [{ id: 'invoice-1' }],
    })
  })
})
