/**
 * Second dev entry — the acceptance page for `src/kit`.
 *
 *     npm run dev      →  http://127.0.0.1:5173/kit.html
 *
 * Deliberately a sibling of `index.html` rather than a new catalog destination: `App.vue` and
 * `destinations.ts` mirror the Android catalog 1:1, and bolting a non-Kotlin screen into that
 * navigation would break the thing the port is measuring.
 *
 * Not part of the build input on purpose: `vite build` only takes `index.html`, so this page never
 * reaches the deployed demo artifact and cannot drift the published site's shape.
 *
 * The plugin is installed with an explicit `theme`, which is also how the page proves the context
 * actually arrived: a no-op provider would leave the readout at `'system'`.
 */
import { createApp } from 'vue'

import { GlassPlugin } from '@/kit'
import KitDemo from './KitDemo.vue'

createApp(KitDemo).use(GlassPlugin, { theme: 'light' }).mount('#app')
