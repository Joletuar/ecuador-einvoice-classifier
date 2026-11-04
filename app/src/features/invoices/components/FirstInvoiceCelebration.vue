<script setup lang="ts">
const colors = ['bg-[#bb7f19]', 'bg-[#528ac1]', 'bg-[#37866a]']
</script>

<template>
  <Teleport to="body">
    <div
      data-first-invoice-celebration
      class="pointer-events-none fixed inset-0 z-[150] overflow-hidden motion-reduce:hidden"
      aria-hidden="true"
    >
      <i
        v-for="n in 48"
        :key="n"
        class="absolute h-[11px] w-[7px] [left:calc(mod(var(--n)*37,100)*1%)] [top:calc(mod(var(--n)*53,75)*1vh_-_20vh)] animate-[invoice-confetti_3.4s_ease-in_forwards] [animation-delay:calc(mod(var(--n),8)*70ms)]"
        :class="colors[n % colors.length]"
        :style="{ '--n': n }"
      />
    </div>
  </Teleport>
</template>

<style>
@keyframes invoice-confetti {
  to {
    transform: translateY(108vh) rotate(620deg);
    opacity: 0;
  }
}
</style>
