<script setup lang="ts">
import { Button } from '../../../shared/ui/button'
import { informationContent } from '../config/informationContent'

const { project, author, survey, tutorials } = informationContent
</script>

<template>
  <div class="grid min-w-0 gap-6">
    <header class="rounded-lg border border-line bg-surface p-4 sm:p-6">
      <h1 class="text-2xl font-bold">{{ project.title }}</h1>
      <p class="mt-3 text-sm leading-6">{{ project.purpose }}</p>
    </header>

    <section
      aria-label="Videos de ayuda"
      class="grid min-w-0 gap-6 lg:grid-cols-2"
    >
      <article
        v-for="tutorial in tutorials"
        :key="tutorial.id"
        :aria-labelledby="`${tutorial.id}-heading`"
        class="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
      >
        <h2
          :id="`${tutorial.id}-heading`"
          class="text-base font-bold"
        >
          {{ tutorial.title }}
        </h2>
        <iframe
          :id="`${tutorial.id}-player`"
          :src="`https://www.youtube.com/embed/${tutorial.youtubeVideoId}?autoplay=0&controls=1&fs=1`"
          :title="`${tutorial.title}${tutorial.isExample ? ' (video de ejemplo)' : ''}`"
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen
          class="tutorial-player block w-full rounded-md border-0 bg-canvas"
        />
      </article>
    </section>

    <div class="grid min-w-0 gap-6 md:grid-cols-2">
      <section
        aria-labelledby="author-heading"
        class="flex min-w-0 flex-col items-start gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
      >
        <h2
          id="author-heading"
          class="text-lg font-bold"
        >
          Sobre el autor
        </h2>
        <p class="flex-1 text-sm leading-6 text-ink-muted">
          {{ author.biography }}
        </p>
        <Button
          v-if="author.linkedinUrl"
          as="a"
          :href="author.linkedinUrl"
          target="_blank"
          rel="noopener noreferrer"
          variant="outline"
          class="h-11 w-full sm:h-9 sm:w-auto"
        >
          Ver LinkedIn
        </Button>
        <Button
          v-else
          type="button"
          variant="outline"
          class="h-11 w-full sm:h-9 sm:w-auto"
          disabled
        >
          Ver LinkedIn
        </Button>
      </section>

      <section
        aria-labelledby="survey-heading"
        class="flex min-w-0 flex-col items-start gap-4 rounded-lg border border-line bg-surface p-4 sm:p-6"
      >
        <h2
          id="survey-heading"
          class="text-lg font-bold"
        >
          Comparte tu opinión
        </h2>
        <p class="flex-1 text-sm leading-6 text-ink-muted">
          Comparte tu experiencia utilizando la aplicación y ayúdanos a
          mejorarla completando la encuesta.
        </p>
        <Button
          v-if="survey.url"
          as="a"
          :href="survey.url"
          target="_blank"
          rel="noopener noreferrer"
          class="h-11 w-full sm:h-9 sm:w-auto"
        >
          Responder encuesta
        </Button>
        <Button
          v-else
          type="button"
          class="h-11 w-full sm:h-9 sm:w-auto"
          disabled
        >
          Responder encuesta
        </Button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tutorial-player {
  height: auto;
  min-height: 200px;
  aspect-ratio: 16 / 9;
}
</style>
