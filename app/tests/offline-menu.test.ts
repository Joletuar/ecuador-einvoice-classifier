// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import OfflineMenu from '../src/features/offline/components/OfflineMenu.vue'
import type { OfflineView } from '../src/features/offline/services/offlineService'

const wrappers: { unmount(): void }[] = []

afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

function menu() {
  const view: OfflineView = {
    tone: 'warning',
    label: 'Algunas funciones no están disponibles.',
    items: [
      {
        label: 'Consultar facturas',
        detail: 'El almacenamiento no está disponible.',
        tone: 'warning',
      },
      {
        label: 'Procesar archivos',
        detail: 'No se pudo preparar el clasificador.',
        tone: 'warning',
      },
      { label: 'Interfaz', tone: 'success' },
    ],
    updateAvailable: true,
    updateLabel: 'Actualizar aplicación',
  }
  const wrapper = mount(OfflineMenu, {
    props: { view, canRetry: true },
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        PopoverRoot: true,
        PopoverTrigger: true,
        PopoverPortal: true,
        PopoverContent: true,
      },
    },
  })

  wrappers.push(wrapper)

  return { wrapper, view }
}

describe('one offline recovery control', () => {
  it('has one recovery action separate from application updates and retains capability details', async () => {
    const { wrapper } = menu()
    const retry = wrapper
      .findAll('button')
      .filter((button) => button.text() === 'Reintentar')

    expect(retry).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Reintentar consulta')
    expect(wrapper.text()).not.toContain('Volver a intentar')
    await retry[0]!.trigger('click')
    expect(wrapper.emitted('retry')).toEqual([[]])
    expect(wrapper.emitted('update')).toBeUndefined()
    expect(wrapper.text()).toContain('Consultar facturas')
    expect(wrapper.text()).toContain('Procesar archivos')
    expect(wrapper.text()).toContain('Interfaz')
    expect(
      wrapper
        .find('ul[aria-label="Funciones no disponibles"]')
        .element.contains(retry[0]!.element),
    ).toBe(false)
  })

  it('shows one disabled busy control throughout recovery', async () => {
    const { wrapper } = menu()

    await wrapper.setProps({ retrying: true })

    const busy = wrapper
      .findAll('button')
      .filter((button) => button.text() === 'Reintentando…')

    expect(busy).toHaveLength(1)
    expect(busy[0]!.attributes('disabled')).toBeDefined()
    expect(busy[0]!.attributes('aria-busy')).toBe('true')
    await busy[0]!.trigger('click')
    expect(wrapper.emitted('retry')).toBeUndefined()
  })

  it('keeps both recovery and update controls disabled during pending activation', async () => {
    const { wrapper, view } = menu()

    await wrapper.setProps({ view: { ...view, updatePending: true } })

    for (const text of ['Reintentar', 'Actualizar aplicación']) {
      const control = wrapper
        .findAll('button')
        .find((button) => button.text() === text)!

      expect(control.attributes('disabled')).toBeDefined()
      await control.trigger('click')
    }

    expect(wrapper.emitted('retry')).toBeUndefined()
    expect(wrapper.emitted('update')).toBeUndefined()
  })

  it('prioritizes the update action and keeps its attention hint until the backend clears availability', async () => {
    const { wrapper, view } = menu()
    const trigger = wrapper.findAll('button')[0]!
    const update = wrapper
      .findAll('button')
      .filter((button) => button.text() === view.updateLabel)

    expect(trigger.text()).toContain('Actualización disponible')
    expect(update).toHaveLength(1)
    expect(update[0]!.classes()).toContain('bg-primary')
    expect(update[0]!.find('svg[aria-hidden="true"]').exists()).toBe(true)
    expect(
      wrapper
        .findAll('p')
        .some((paragraph) => paragraph.text() === 'Actualización disponible'),
    ).toBe(false)
    expect(wrapper.text().indexOf(view.updateLabel)).toBeLessThan(
      wrapper.text().indexOf(view.label),
    )
    await update[0]!.trigger('click')
    expect(wrapper.emitted('update')).toEqual([[]])
    expect(trigger.text()).toContain('Actualización disponible')

    await wrapper.setProps({ view: { ...view, updateAvailable: false } })

    expect(trigger.text()).not.toContain('Actualización disponible')
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text() === view.updateLabel),
    ).toBe(false)
  })
})
