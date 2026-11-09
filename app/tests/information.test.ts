// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import InformationPage from '../src/features/information/pages/InformationPage.vue'
import { informationContent } from '../src/features/information/config/informationContent'

const initialContent = structuredClone(informationContent)
const wrappers: { unmount(): void }[] = []

function renderInformation() {
  const wrapper = mount(InformationPage)

  wrappers.push(wrapper)

  return wrapper
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount()
  }

  Object.assign(informationContent, structuredClone(initialContent))
})

describe('information screen', () => {
  it('shows one purpose paragraph and simple author and survey cards with disabled unconfigured actions', () => {
    const wrapper = renderInformation()
    const author = wrapper.get('section[aria-labelledby="author-heading"]')
    const survey = wrapper.get('section[aria-labelledby="survey-heading"]')

    expect(wrapper.get('h1').text()).toBe('Sobre Mis facturas')
    expect(wrapper.get('header').findAll('p')).toHaveLength(1)
    expect(wrapper.get('header p').text()).toBe(
      informationContent.project.purpose,
    )
    expect(wrapper.text()).not.toContain('Un proyecto académico sobre')
    expect(wrapper.text()).toContain('facturas electrónicas ecuatorianas')
    expect(author.get('h2').text()).toBe('Sobre el autor')
    expect(author.findAll('p')).toHaveLength(1)
    expect(author.get('p').text()).toBe('Presentación pendiente.')
    expect(survey.findAll('p')).toHaveLength(1)
    expect(survey.get('p').text()).toContain('encuesta de Google Forms')
    expect(wrapper.text()).not.toContain('Autor del proyecto')
    expect(wrapper.text()).not.toContain('Enlace de LinkedIn pendiente.')
    expect(wrapper.text()).not.toContain('Enlace de la encuesta pendiente.')
    expect(wrapper.findAll('button').map((button) => button.text())).toEqual([
      'Ver LinkedIn',
      'Responder encuesta',
    ])

    for (const button of wrapper.findAll('button')) {
      expect(button.element.disabled).toBe(true)
      expect(button.attributes('aria-describedby')).toBeUndefined()
    }

    expect(informationContent.author.linkedinUrl).toBe('')
    expect(informationContent.survey.url).toBe('')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('keeps video titles and players without an introductory heading, notice or descriptions', () => {
    const wrapper = renderInformation()
    const videos = wrapper.get('section[aria-label="Videos de ayuda"]')

    expect(videos.findAll('h2').map((heading) => heading.text())).toEqual([
      'Descargar XML del SRI',
      'Usar Mis facturas',
    ])
    expect(videos.findAll('iframe')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('Tutoriales')
    expect(wrapper.text()).not.toContain(
      'Videos de ejemplo, pendientes de reemplazar por los tutoriales.',
    )
    expect(wrapper.text()).not.toContain(
      'Descarga tus facturas electrónicas en formato XML desde el portal del SRI',
    )
    expect(wrapper.text()).not.toContain('Carga tus XML o ZIP en Cargar.')
  })

  it('embeds two distinct official YouTube players directly with manual playback and accessible titles', () => {
    const wrapper = renderInformation()
    const players = wrapper.findAll('iframe')
    const sources = players.map((player) => new URL(player.element.src))

    expect(players).toHaveLength(2)
    expect(sources.map((source) => source.pathname)).toEqual([
      '/embed/M7lc1UVf-VE',
      '/embed/aqz-KE-bpKQ',
    ])
    expect(new Set(players.map((player) => player.attributes('id'))).size).toBe(
      2,
    )
    expect(
      new Set(players.map((player) => player.attributes('title'))).size,
    ).toBe(2)

    for (const [index, player] of players.entries()) {
      const source = sources[index]!

      expect(source.origin).toBe('https://www.youtube.com')
      expect(source.searchParams.get('autoplay')).toBe('0')
      expect(source.searchParams.get('controls')).toBe('1')
      expect(source.searchParams.get('fs')).toBe('1')
      expect(source.searchParams.has('enablejsapi')).toBe(false)
      expect(player.attributes('title')).toContain('video de ejemplo')
      expect(player.attributes('loading')).toBe('lazy')
      expect(player.attributes('referrerpolicy')).toBe(
        'strict-origin-when-cross-origin',
      )
      expect(player.attributes('allowfullscreen')).toBeDefined()
      expect(player.attributes('allow')).toContain('fullscreen')
      expect(player.attributes('allow')).not.toContain('autoplay')
    }
  })

  it('uses edited author and link content and removes the accessible example qualifier from final videos', () => {
    informationContent.author = {
      biography: 'Nombre de prueba. Presentación de prueba del autor.',
      linkedinUrl: 'https://www.linkedin.com/',
    }
    informationContent.survey.url = 'https://docs.google.com/forms/'
    informationContent.tutorials = informationContent.tutorials.map(
      (tutorial) => ({ ...tutorial, isExample: false }),
    )

    const wrapper = renderInformation()
    const links = wrapper.findAll('a')

    expect(wrapper.text()).toContain(
      'Nombre de prueba. Presentación de prueba del autor.',
    )
    expect(links.map((link) => link.attributes('href'))).toEqual([
      'https://www.linkedin.com/',
      'https://docs.google.com/forms/',
    ])

    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noopener noreferrer')
    }

    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('pendiente')
    expect(
      wrapper.findAll('iframe').map((player) => player.attributes('title')),
    ).toEqual(['Descargar XML del SRI', 'Usar Mis facturas'])
  })
})
