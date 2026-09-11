<script setup lang="ts">
import { ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import FlightIcon from '@/components/FlightIcon.vue'
import LiquidBottomTab from '@/components/LiquidBottomTab.vue'
import LiquidBottomTabs from '@/components/LiquidBottomTabs.vue'
import { useTheme } from '@/composables/backdrop-context'

/** `BottomTabsContent` — a 3-tab and a 4-tab liquid bottom bar. */
const { isLightTheme } = useTheme()

const threeTabIndex = ref(0)
const fourTabIndex = ref(0)
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="tabs-page">
      <div class="tabs-page__row">
        <LiquidBottomTabs
          :selected-index="threeTabIndex"
          :tabs-count="3"
          :is-light-theme="isLightTheme"
          :backdrop="backdrop"
          @select="threeTabIndex = $event"
        >
          <template #tabs>
            <LiquidBottomTab
              v-for="index in 3"
              :key="index"
              :selected="threeTabIndex === index - 1"
              @click="threeTabIndex = index - 1"
            >
              <span class="tabs-page__icon" :style="{ color: isLightTheme ? '#000' : '#fff' }">
                <FlightIcon />
              </span>
              <span class="tabs-page__label">Tab {{ index }}</span>
            </LiquidBottomTab>
          </template>
        </LiquidBottomTabs>
      </div>

      <div class="tabs-page__row">
        <LiquidBottomTabs
          :selected-index="fourTabIndex"
          :tabs-count="4"
          :is-light-theme="isLightTheme"
          :backdrop="backdrop"
          @select="fourTabIndex = $event"
        >
          <template #tabs>
            <LiquidBottomTab
              v-for="index in 4"
              :key="index"
              :selected="fourTabIndex === index - 1"
              @click="fourTabIndex = index - 1"
            >
              <span class="tabs-page__icon" :style="{ color: isLightTheme ? '#000' : '#fff' }">
                <FlightIcon />
              </span>
              <span class="tabs-page__label">Tab {{ index }}</span>
            </LiquidBottomTab>
          </template>
        </LiquidBottomTabs>
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.tabs-page {
  display: flex;
  flex-direction: column;
  gap: 32px;
  width: 100%;
}

.tabs-page__row {
  padding: 0 36px;
}

.tabs-page__icon {
  display: block;
  width: 28px;
  height: 28px;
}

.tabs-page__label {
  font-size: 12px;
}
</style>
