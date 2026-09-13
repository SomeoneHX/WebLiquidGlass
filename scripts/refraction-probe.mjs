#!/usr/bin/env node
/**
 * refraction-probe.mjs — measure what the refraction *actually* does, in two independent layers.
 *
 *   node scripts/refraction-probe.mjs map                 # encoder: bytes -> predicted px offset
 *   node scripts/refraction-probe.mjs render [--dpr=1]    # sampler: pixels -> measured px offset
 *
 * ## Why two layers
 *
 * The endpoint (`backdrop-filter: <blur…> url(#filter)`) has two quantisers in series and they
 * are constantly confused with each other:
 *
 *   1. **the encoder** — our own 8-bit displacement map. Channel *c* is read by
 *      `feDisplacementMap` as `offset_css_px = scale * (c/255 - 0.5)`, so one channel step is
 *      `scale/255 px`. `scale = 2 * amount * vmax`, so the step is `2*amount*vmax/255 px`.
 *   2. **the sampler** — Skia rounds the displaced coordinate and reads nearest-neighbour.
 *      That is a hard `1 device px` floor and it is *not* a function of anything we write into
 *      the map. Empirically `offset = round(scale * (c/255 - 0.5))`.
 *
 * `map` models layer 1 from the *real committed code* (it evaluates the extracted core out of
 * `userscript/liquid-glass-refract.user.js`, segment 1 — no duplication, no browser). `render`
 * measures layer 2 in a real Chromium against a phase-ruler backdrop.
 *
 * ## The phase ruler
 *
 * A sawtooth backdrop of period `P` device px: `value(x) = round(((x mod P) / P) * 255)`.
 * Nearest-neighbour sampling returns the ruler value at the *source* pixel, so a measured
 * luminance gives the source position to within half a channel — and because `P` is chosen
 * larger than any offset we probe, `s(x) = phase(L(x)) - phase(L0(x))` is unambiguous, no
 * unwrapping. A nearest sampler makes the recovered `s(x)` land on a 1-device-px lattice; a
 * bilinear sampler makes it continuous. That single distinction is the whole question.
 *
 * Zero dependencies: CDP over the built-in `WebSocket`, PNG decoded with the built-in `zlib`.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const USERSCRIPT = join(ROOT, 'userscript', 'liquid-glass-refract.user.js')
const CHROME =
  process.env.CHROME_PATH ??
  join(
    process.env.HOME,
    'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/' +
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  )

/* ------------------------------------------------------------------------------------------- */
/* PNG decode (8-bit truecolour, non-interlaced) — enough for a CDP screenshot                   */
/* ------------------------------------------------------------------------------------------- */

function decodePng(buffer) {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat = []
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('latin1', pos + 4, pos + 8)
    const chunk = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
      if (chunk[12] !== 0) throw new Error('interlaced PNG not supported')
      if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`)
    } else if (type === 'IDAT') idat.push(chunk)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 255
      else if (filter === 2) line[i] = (line[i] + b) & 255
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { width, height, channels, data: out }
}

const luma = (img, x, y) => img.data[(y * img.width + x) * img.channels] // image is pure grey
const chan = (img, x, y, c) => img.data[(y * img.width + x) * img.channels + c]

/* ------------------------------------------------------------------------------------------- */
/* `map` — encoder model, straight out of the shipping core                                      */
/* ------------------------------------------------------------------------------------------- */

/** The extracted core as committed: segment 1 of the userscript, evaluated with a stub canvas. */
function loadCore() {
  const source = readFileSync(USERSCRIPT, 'utf8')
  const start = source.indexOf('* SVG refraction filter for')
  const end = source.indexOf('* 2. Userscript host')
  if (start < 0 || end < 0) throw new Error('could not find segment 1 in the userscript')
  const body = source.slice(source.lastIndexOf('/*', start), source.lastIndexOf('/*', end))

  const canvases = []
  const document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        image: null,
        getContext: () => ({
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (im) => (canvas.image = im)
        }),
        toDataURL: () => 'data:image/png;base64,stub'
      }
      canvases.push(canvas)
      return canvas
    }
  }
  const factory = new Function(
    'document',
    'navigator',
    'window',
    `${body}\nreturn { buildMap, FILTER_PAD };`
  )
  const core = factory(document, { userAgent: 'chrome' }, {})
  return { core, canvases }
}

/**
 * Run `buildMap` for one spec, then reduce the rim to the numbers a camera would see:
 * the channel ladder and, for a given amount, the resulting integer-px offset ladder.
 */
function analyseMap(spec, amount, branch) {
  const { core, canvases } = loadCore()
  canvases.length = 0
  const refractionSpec = {
    width: spec.w,
    height: spec.h,
    cornerRadii: [spec.r, spec.r, spec.r, spec.r],
    refractionHeight: spec.bezel,
    depthEffect: spec.depth,
    chromaticAberration: spec.ca
  }
  const { vmax } = core.buildMap(refractionSpec, branch)
  const pad = core.FILTER_PAD
  const image = canvases[canvases.length - 1].image
  const cw = image.width
  const rows = []
  for (let y = Math.round(spec.h / 2) - 6; y <= Math.round(spec.h / 2) + 6; y++) rows.push(y + pad)

  const scale = amount * 2 * vmax
  const offsetAt = (c) => Math.round(scale * (c / 255 - 0.5))

  // Columns walking inward from the *left* rim: x = -1 is the last pixel outside the shape.
  const columns = []
  for (let x = -1; x <= spec.bezel + 3; x++) {
    const i = x + pad
    const reds = rows.map((j) => image.data[(j * cw + i) * 4])
    reds.sort((a, b) => a - b)
    const median = reds[reds.length >> 1]
    columns.push({ x, channel: median, offset: offsetAt(median) })
  }

  // Interior identity: any rim-free column must encode exact neutral.
  const interior = []
  for (let i = pad + spec.bezel + 6; i < cw - pad - spec.bezel - 6; i++) {
    if (image.data[(rows[0] * cw + i) * 4] !== 128) interior.push(i - pad)
  }

  const ladder = []
  for (const column of columns) {
    const last = ladder[ladder.length - 1]
    if (last && last.offset === column.offset) last.to = column.x
    else ladder.push({ offset: column.offset, from: column.x, to: column.x, channel: column.channel })
  }
  let maxJump = 0
  for (let i = 1; i < columns.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(columns[i].offset - columns[i - 1].offset))
  }

  return {
    vmax,
    scale,
    channelStep: scale / 255,
    columns,
    ladder,
    maxJump,
    interiorViolations: interior.length,
    neutralBias: Math.abs(scale * (128 / 255 - 0.5))
  }
}

const CATALOG = [
  { name: 'LiquidToggle thumb', w: 48, h: 28, r: 14, bezel: 5, amount: 10, depth: false, ca: true },
  { name: 'LiquidSlider thumb', w: 48, h: 28, r: 14, bezel: 10, amount: 14, depth: false, ca: true },
  { name: 'BottomTabs indicator', w: 120, h: 56, r: 28, bezel: 10, amount: 14, depth: false, ca: true },
  { name: 'BottomTabs container', w: 360, h: 64, r: 32, bezel: 24, amount: 24, depth: false, ca: true },
  { name: 'LiquidButton', w: 120, h: 48, r: 24, bezel: 12, amount: 24, depth: false, ca: false },
  { name: 'ScrollContainer row', w: 320, h: 180, r: 20, bezel: 16, amount: 32, depth: false, ca: false },
  { name: 'Dialog', w: 320, h: 400, r: 28, bezel: 24, amount: 48, depth: true, ca: false },
  { name: 'Magnifier lens', w: 200, h: 200, r: 12, bezel: 8, amount: 24, depth: true, ca: true }
]

function runMap() {
  const fixed = (v, n = 3) => v.toFixed(n).padStart(6)
  console.log('\n=== LAYER 1 — the 8-bit encoder (predicted, from the committed core) ===\n')
  console.log(
    'spec                       vmax  scale  chStep  bias   offset ladder across the bezel (px)'
  )
  console.log(
    '                                 (px)   (px)   (px)   [outward rim  ->  inward]'
  )
  for (const spec of CATALOG) {
    const branch = spec.ca ? 1 : 0
    const r = analyseMap(spec, spec.amount, branch)
    const ladder = r.ladder
      .slice()
      .reverse()
      .map((step) => `${step.offset}@x${step.from}..${step.to}`)
      .join('  ')
    console.log(
      `${spec.name.padEnd(24)} ${fixed(r.vmax)}  ${fixed(r.scale, 1)}  ${fixed(
        r.channelStep,
        2
      )}  ${fixed(r.neutralBias, 3)}  ${ladder}`
    )
    const bad = r.interiorViolations ? `  ⚠ interior non-neutral: ${r.interiorViolations}` : ''
    console.log(
      `  bezel ${String(spec.bezel).padStart(2)}px, amount ${String(spec.amount).padStart(2)}px, ` +
        `ratio ${(spec.amount / spec.bezel).toFixed(2)}, distinct integer offsets ` +
        `${r.ladder.length}, max jump between adjacent columns ${r.maxJump}px, ` +
        `bias as a fraction of the sampler step ${(r.neutralBias).toFixed(2)}px${bad}`
    )
  }
  console.log(
    '\nRead: `bias` is the whole of the 127.5-vs-128 story — it reaches the 1 px sampler step\n' +
      'only above `amount*vmax = 255`, and the catalog tops out at 48*vmax. `max jump` is the\n' +
      'thing that is actually visible: it is one *channel* of the map, resolved to whole px.\n'
  )
}

/* ------------------------------------------------------------------------------------------- */
/* `render` — the sampler, measured in Chromium                                                   */
/* ------------------------------------------------------------------------------------------- */

const FIXTURE = ({ slope, bg, blur, bezel, scale, lens, compensate }) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #000; }
  #bg { position: fixed; left: 0; top: 0; }
  #lens { position: fixed; left: ${lens.x}px; top: ${lens.y}px;
          width: ${lens.w}px; height: ${lens.h}px;
          border-radius: ${lens.r}px;
          transform-origin: top left;${scale === 1 ? '' : ` transform: scale(${scale});`} }
</style>
<canvas id="bg"></canvas>
<div id="lens"></div>
<script src="./core.js"></script>
<script>
  const DPR = window.devicePixelRatio
  const W = 1000, H = 520, S = ${slope}          // ruler: S levels per device px, mod 256
  const bg = document.getElementById('bg')
  bg.style.width = W + 'px'; bg.style.height = H + 'px'
  bg.width = W * DPR; bg.height = H * DPR
  {
    const ctx = bg.getContext('2d')
    const img = ctx.createImageData(bg.width, bg.height)
    for (let x = 0; x < bg.width; x++) {
      for (let y = 0; y < bg.height; y++) {
        let r, g
        if ('${bg}' === 'checker') {
          // One device pixel per square: the highest frequency a backdrop can carry, so every
          // sampling mistake shows up as a full-contrast seam.
          r = g = ((x + y) & 1) ? 255 : 0
        } else if ('${bg}' === 'noise') {
          // Deterministic per-device-pixel noise. Aligning two shots by SSD then has a single
          // sharp minimum, so a rigid translation shows up as an exact integer (dx, dy) with a
          // near-zero residual, while any interpolation would smear it off the lattice.
          let h = (x * 374761393 + y * 668265263) | 0
          h = Math.imul(h ^ (h >>> 13), 1274126177)
          r = g = (h ^ (h >>> 16)) & 255
        } else if ('${bg}' === 'xy') {
          // R encodes the x coordinate, G the y coordinate: one screenshot yields a *signed*
          // (dx, dy) for the whole interior.
          r = (((S * x) % 256) + 256) % 256
          g = (((S * y) % 256) + 256) % 256
        } else {
          // Ruler: (S*x) mod 256 — the slope is exactly S levels per device px *everywhere*,
          // not just on average. A round(x * 255/P) ramp alternates between integer steps
          // (3,4,3,4...) whose local slope differs from its mean by up to 0.4%, and that bias
          // multiplies with the offset measured (it showed up as every plateau reading 0.4%
          // high). The per-row phase stride moves the sawtooth reset off any single column, so
          // the per-column median drops the rows that land on it; it cancels in L - L0.
          r = g = (((S * x + 13 * y) % 256) + 256) % 256
        }
        const i = (y * bg.width + x) * 4
        img.data[i] = r
        img.data[i + 1] = g
        img.data[i + 2] = 0
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }
  const OPTS = { blur: ${blur}, saturate: 1, brightness: 1,
                 depthEffect: ${bezel.depth}, chromaticAberration: false,
                 refractionHeight: ${bezel.height}, refractionAmount: 0 }
  // A scaled element has to bypass the host: the host reads getBoundingClientRect(), which
  // reports the *transformed* box, but the filter graph and its map live in the element's own
  // local space. Driving the core directly keeps the map in local px, which is the whole point
  // of this mode — the on-screen geometry is then exactly the local geometry times ${scale}.
  const f = ${scale === 1 ? 'null' : 'LiquidGlassRefract.createGlassFilter()'}
  // Compensation experiment: the neutral byte is 128, not 127.5, so every pixel is sampled from
  // +scale/510 in both axes. An feOffset of exactly that amount, appended after the
  // displacement, should put the neutral region back on the identity — provided the rasteriser
  // applies a fractional feOffset as a fractional translate rather than snapping it.
  const NS = 'http://www.w3.org/2000/svg'
  const compensate = ${compensate ? 'true' : 'false'}
  const offset = compensate ? document.createElementNS(NS, 'feOffset') : null
  function applyCompensation(target) {
    if (!offset || !target) return
    const disp = target.querySelector('feDisplacementMap')
    if (!disp) return
    const s = Number(disp.getAttribute('scale'))
    const b = s * (128 / 255 - 0.5)
    // No 'in' attribute: appended last, it offsets the chain's previous result.
    offset.setAttribute('dx', String(b))
    offset.setAttribute('dy', String(b))
    const last = target.lastElementChild
    if (!last || last.tagName !== 'feOffset') target.append(offset)
  }
  window.__set = (amount) => {
    OPTS.refractionAmount = amount
    const el = document.getElementById('lens')
    if (!f) {
      window.LiquidGlassRefract.apply(el, OPTS)
      applyCompensation(document.querySelector('svg filter'))
      return
    }
    f.update(
      { width: ${lens.w}, height: ${lens.h},
        cornerRadii: [${lens.r}, ${lens.r}, ${lens.r}, ${lens.r}],
        refractionHeight: OPTS.refractionHeight, depthEffect: OPTS.depthEffect,
        chromaticAberration: false },
      amount
    )
    el.style.backdropFilter = 'blur(' + OPTS.blur + 'px) url(#' + f.id + ')'
    el.style.setProperty('-webkit-backdrop-filter', el.style.backdropFilter)
    applyCompensation(document.getElementById(f.id))
  }
  window.__hide = (hidden) => { document.getElementById('lens').style.display = hidden ? 'none' : '' }
  window.__set(0)
</script>`

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve)
      this.socket.addEventListener('error', (event) => reject(new Error(String(event.message ?? event.type))))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const key = message.id
      const slot = this.pending.get(key)
      if (!slot) return
      this.pending.delete(key)
      if (message.error) slot.reject(new Error(`${message.error.message} (${slot.method})`))
      else slot.resolve(message.result)
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.socket.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }
}

async function withChrome({ headed, gpu }, fn) {
  const port = 9333 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'refract-probe-'))
  const flags = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--allow-file-access-from-files',
    '--window-size=1000,520'
  ]
  if (!headed) flags.unshift('--headless=new')
  if (gpu) flags.push('--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist')
  // `detached` puts the browser and every helper it spawns in one process group, so a single
  // kill cleans up the whole tree — Chrome's launcher is not the process that holds the port.
  const child = spawn(CHROME, flags, { stdio: 'ignore', detached: true })
  let wsUrl = null
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      wsUrl = info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) {
    child.kill()
    throw new Error('chrome did not expose a debugging endpoint')
  }
  const cdp = new CDP(wsUrl)
  await cdp.ready
  try {
    return await fn(cdp)
  } finally {
    cdp.socket.close()
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    // Chrome is still flushing its profile; the temp dir is the OS's to reap.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
    } catch {
      /* best effort */
    }
  }
}

async function runRender(options) {
  const dpr = options.dpr
  const dir = mkdtempSync(join(tmpdir(), 'refract-fixture-'))
  // The committed userscript, verbatim — the host is exercised, not a copy of it.
  writeFileSync(join(dir, 'core.js'), readFileSync(USERSCRIPT, 'utf8'))
  const slope = dpr === 1 ? 3 : dpr === 2 ? 2 : 1 // levels per device px; range 256/slope px
  writeFileSync(
    join(dir, 'index.html'),
    FIXTURE({
      slope,
      bg: options.bg,
      blur: options.blur,
      bezel: { height: options.bezel, depth: options.depth },
      scale: options.scale,
      compensate: options.compensate,
      lens: options.lens
    })
  )
  const url = 'file://' + join(dir, 'index.html')

  // Independent layer-1 prediction for the very same spec, so a disagreement between what the
  // encoder promises and what the sampler does cannot hide behind an assumed `vmax`.
  const { core } = loadCore()
  const vmax = core.buildMap(
    {
      width: options.lens.w,
      height: options.lens.h,
      cornerRadii: [options.lens.r, options.lens.r, options.lens.r, options.lens.r],
      refractionHeight: options.bezel,
      depthEffect: options.depth,
      chromaticAberration: false
    },
    0
  ).vmax

  const report = await withChrome(options, async (cdp) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => cdp.send(method, params, sessionId)

    let gpuLine = 'unknown'
    try {
      const info = await cdp.send('SystemInfo.getInfo')
      gpuLine = (info.gpu?.devices ?? [])
        .map((d) => `${d.deviceString}${d.deviceId === 0 ? ' (software)' : ''}`)
        .join(' / ') || 'none'
    } catch {
      /* SystemInfo is optional */
    }

    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 520,
      deviceScaleFactor: dpr,
      mobile: false
    })
    await send('Page.navigate', { url })
    await send('Runtime.evaluate', { expression: 'document.readyState', awaitPromise: false })
    await new Promise((r) => setTimeout(r, 900))

    const shoot = async () => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      return decodePng(Buffer.from(data, 'base64'))
    }
    const setAmount = async (amount) => {
      await send('Runtime.evaluate', {
        expression: `window.__set(${amount})`,
        awaitPromise: false
      })
      await new Promise((r) => setTimeout(r, 260))
    }

    const errors = await send('Runtime.evaluate', {
      expression: 'typeof window.LiquidGlassRefract',
      returnByValue: true
    })
    if (errors.result?.value !== 'object') {
      throw new Error(`fixture did not load the userscript (window.LiquidGlassRefract = ${errors.result?.value})`)
    }

    await send('Runtime.evaluate', { expression: 'window.__hide(true)' })
    await new Promise((r) => setTimeout(r, 120))
    const reference = await shoot()
    await send('Runtime.evaluate', { expression: 'window.__hide(false)' })
    await new Promise((r) => setTimeout(r, 120))

    // Columns of interest, in *device* px: the left rim at CSS x=240 plus the whole bezel.
    const front = Math.round(240 * dpr)
    const y0 = Math.round(240 * dpr)

    /**
     * Rigid-translation search: the integer (dx, dy) at which the lens patch best matches the
     * reference, i.e. the displacement map's own offset where the map is neutral. This is the
     * only measurement that reports a *sign*, and it is the one that decides whether the
     * interior is bit-exact, drifting, or genuinely sub-pixel.
     *
     * Returned as `sample` = where the pixel is read from: `shot(x, y) == ref(x+dx, y+dy)`.
     * The content therefore moves by `-(dx, dy)`.
     */
    const rigidShift = (shot, radius, px, py, half) => {
      const cost = (dx, dy) => {
        let sum = 0
        for (let y = py - half; y < py + half; y++) {
          for (let x = px - half; x < px + half; x++) {
            const delta = luma(shot, x, y) - luma(reference, x + dx, y + dy)
            sum += delta * delta
          }
        }
        return sum
      }
      let best = { dx: 0, dy: 0, cost: Infinity }
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const c = cost(dx, dy)
          if (c < best.cost) best = { dx, dy, cost: c }
        }
      }
      // Parabolic refinement: lands on the integer when the match is a rigid whole-pixel move,
      // and reveals a genuine fraction when it is not.
      const along = (which) => {
        const at = (k) => (which === 'x' ? cost(best.dx + k, best.dy) : cost(best.dx, best.dy + k))
        const [cm, c0, cp] = [at(-1), at(0), at(1)]
        const denom = cm - 2 * c0 + cp
        return denom === 0 ? 0 : (0.5 * (cm - cp)) / denom
      }
      const samples = Math.pow(half * 2, 2)
      return {
        dx: best.dx,
        dy: best.dy,
        sub: { x: along('x'), y: along('y') },
        rms: Math.sqrt(best.cost / samples)
      }
    }

    /**
     * Inward shift at output column `cx`, in device px.
     *
     * The ruler is `(S*x) mod 256`, so `L - L0 ≡ S * s (mod 256)` and, because `s` never
     * exceeds `256/S`, the residue *is* `S * s` — no continuity assumption, no branch cut. Rows
     * whose source pixel sits on the sawtooth reset return garbage, so the per-column median
     * discards them (the reset lands on a different column on every row).
     */
    const shiftAt = (img, cx) => {
      const samples = []
      for (let y = y0; y < y0 + Math.round(60 * dpr); y += 2) {
        const delta = luma(img, cx, y) - luma(reference, cx, y)
        samples.push((((delta % 256) + 256) % 256) / slope)
      }
      samples.sort((a, b) => a - b)
      return samples[samples.length >> 1]
    }

    const rows = []
    for (const amount of options.amounts) {
      await setAmount(amount)
      const shot = await shoot()

      if (options.probe === 'shift' || options.probe === 'field') {
        const centre = {
          px: Math.round((options.lens.x + options.lens.w / 2) * dpr),
          py: Math.round((options.lens.y + options.lens.h / 2) * dpr),
          half: Math.round((options.probe === 'field' ? 6 : 24) * dpr)
        }
        if (options.probe === 'shift') {
          rows.push({ amount, ...rigidShift(shot, options.search, centre.px, centre.py, centre.half) })
        } else {
          // 3x3 across the element: the interior cells show whether the whole card translates,
          // the edge cells show which way the rim bends it.
          const cells = []
          for (const fy of [0.2, 0.5, 0.8]) {
            const row = []
            for (const fx of [0.2, 0.5, 0.8]) {
              row.push(
                rigidShift(
                  shot,
                  Math.min(options.search, 12),
                  Math.round((options.lens.x + options.lens.w * fx) * dpr),
                  Math.round((options.lens.y + options.lens.h * fy) * dpr),
                  centre.half
                )
              )
            }
            cells.push(row)
          }
          rows.push({ amount, cells })
        }
        continue
      }

      if (options.bg === 'checker') {
        // Contrast across the silhouette: a nearest sampler reading a source pixel `amount` px
        // away lands on an essentially unrelated square of a 1-device-px checkerboard, so the
        // first rim column is a full-contrast seam against the last column outside. Any blur
        // ahead of the displacement shrinks the backdrop's own local contrast, and with it the
        // seam — this is the measurement that decides whether the blur floor is worth its cost.
        const step = (cx, cxPrev) => {
          let sum = 0
          let n = 0
          for (let y = y0; y < y0 + 60 * dpr; y++) {
            sum += Math.abs(luma(shot, cx, y) - luma(shot, cxPrev, y))
            n++
          }
          return sum / n
        }
        const rimSeam = (step(front, front - 1) + step(front + 1, front)) / 2
        let texture = 0
        let count = 0
        for (let cx = Math.round(40 * dpr); cx < Math.round(200 * dpr); cx++) {
          texture += step(cx, cx - 1)
          count++
        }
        rows.push({ amount, rimSeam, texture: texture / count })
        continue
      }

      const dx0 = -Math.round(3 * dpr)
      // The field occupies `bezel * scale` on screen; scan past its inner end.
      const dx1 = Math.round((options.bezel * options.scale + 8) * dpr)
      const profile = []
      for (let dx = dx0; dx <= dx1; dx++) {
        if (dx < 0) continue
        profile.push({ dx, s: shiftAt(shot, front + dx) })
      }

      const levels = []
      for (const point of profile) {
        const last = levels[levels.length - 1]
        if (last && Math.abs(last.value - point.s) < 0.35) last.to = point.dx
        else levels.push({ value: point.s, from: point.dx, to: point.dx })
      }
      let maxJump = 0
      for (let i = 1; i < profile.length; i++) {
        maxJump = Math.max(maxJump, Math.abs(profile[i].s - profile[i - 1].s))
      }
      // The lattice is one *device* px: that is the claim under test, so that is the modulus.
      const residuals = profile.map((p) => Math.abs(p.s - Math.round(p.s)))
      rows.push({
        amount,
        profile,
        levels,
        maxJump,
        maxResidual: Math.max(...residuals),
        meanResidual: residuals.reduce((a, b) => a + b, 0) / residuals.length
      })
    }
    return { rows, reference, gpuLine, slope, dpr }
  })

  const fixed = (v, n = 2) => v.toFixed(n)
  console.log(
    `\n=== LAYER 2 — the sampler, measured (dpr ${dpr}, ${options.headed ? 'headed' : 'headless'}) ===`
  )
  console.log(`rasteriser: ${report.gpuLine}`)
  console.log(
    `backdrop: ${options.bg}, lens blur ${options.blur}px, refractionHeight ${options.bezel}px, ` +
      `element transform scale(${options.scale}) (map kept in local px)`
  )
  console.log(
    `ruler ${slope} levels per device px, range ${fixed(256 / slope, 1)} device px — ` +
      `all offsets below are in *device* px (CSS px = /${dpr})\n`
  )

  if (options.probe === 'field') {
    console.log(
      'each cell: best-fit sample offset (dx, dy) in device px, and rms in grey levels.\n' +
        'the content moves by (-dx, -dy); +x is right, +y is down.'
    )
    for (const row of report.rows) {
      console.log(`\namount ${row.amount}`)
      for (const line of row.cells) {
        console.log(
          '  ' +
            line
              .map(
                (c) =>
                  `(${String(c.dx).padStart(3)},${String(c.dy).padStart(3)}) rms ${c.rms
                    .toFixed(1)
                    .padStart(5)}`
              )
              .join('   ')
        )
      }
    }
    console.log('')
    return
  }

  if (options.probe === 'shift') {
    // `sample` is where each pixel is read from; the content therefore moves the other way.
    console.log(`encoder says vmax = ${vmax.toFixed(4)} → scale = 2 * amount * vmax`)
    console.log(
      'amount | scale | neutral bias | predicted | sample offset | sub-px | content shift | rms'
    )
    for (const row of report.rows) {
      const scale = 2 * row.amount * vmax
      const bias = scale * (128 / 255 - 0.5)
      const predict = Math.round(bias)
      const sub = `${row.sub.x >= 0 ? '+' : ''}${row.sub.x.toFixed(2)}/${row.sub.y >= 0 ? '+' : ''}${row.sub.y.toFixed(2)}`
      console.log(
        `${String(row.amount).padStart(6)} | ${scale.toFixed(1).padStart(6)} | ` +
          `${bias.toFixed(4).padStart(7)} px | ${String(predict).padStart(3)} px | ` +
          `(${String(row.dx).padStart(3)}, ${String(row.dy).padStart(3)}) | ${sub.padStart(11)} | ` +
          `(${String(-row.dx).padStart(3)}, ${String(-row.dy).padStart(3)}) | ${fixed(row.rms, 2)}`
      )
    }
    console.log(
      '\nrms is the match error in grey levels: ~0 means the interior is a rigid whole-pixel\n' +
        'copy of the backdrop — no interpolation anywhere, so a "smooth" drift is still\n' +
        'arithmetic on the device lattice and only looks smooth because a rigid 1 px step of\n' +
        'everything at once is invisible while the slider is moving.\n'
    )
    return
  }

  if (options.bg === 'checker') {
    console.log('amount | contrast across the silhouette (0-255 levels)')
    for (const row of report.rows) {
      console.log(
        `${String(row.amount).padStart(6)} | seam ${fixed(row.rimSeam, 1).padStart(6)}   ` +
          `backdrop texture ${fixed(row.texture, 1).padStart(6)}   ` +
          `seam / texture ${fixed(row.rimSeam / row.texture, 2)}`
      )
    }
    console.log(
      '\nA seam near the backdrop texture means the rim pixel reads unrelated content; a ratio\n' +
        'falling toward 1 means the blur ahead of the displacement has washed the jump out.\n'
    )
    return
  }

  console.log('amount | s(x) inward from the rim, device px — (value @ first dx of the plateau)')
  let allIntegral = true
  for (const row of report.rows) {
    const plateau = row.levels.map((l) => `${fixed(l.value)}@${l.from}`).join('  ')
    console.log(`${String(row.amount).padStart(6)} | ${plateau}`)
    const worst = row.maxResidual
    if (worst > 0.3) allIntegral = false
    console.log(
      `       | plateaus ${String(row.levels.length).padStart(2)}, max jump ${fixed(
        row.maxJump
      )} device px, worst / mean distance off the 1 device px lattice ${fixed(
        worst,
        3
      )} / ${fixed(row.meanResidual, 3)} px`
    )
  }
  console.log(
    `\n${allIntegral ? '✓' : '✗'} every measured offset sits on the 1 device px lattice ` +
      `→ the displaced sample is rounded to a whole device pixel (nearest-neighbour)`
  )
  console.log(
    `   at dpr ${dpr} that is ${fixed(1 / dpr)} CSS px, and the rim plateau count scales with\n` +
      '   `amount * dpr`, so a high-density display halves the visible step of every terrace.'
  )
  console.log(
    '   the field rising to ~amount*dpr at the rim and decaying to 0 across the bezel also says\n' +
      '   the encoder is linear in `amount` and carries no systematic bias.\n'
  )
}

/* ------------------------------------------------------------------------------------------- */

const argv = process.argv.slice(2)
const mode = argv.find((a) => !a.startsWith('--')) ?? 'map'
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const has = (name) => argv.includes(`--${name}`)
const str = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback

/** `--size=256x256 --radius=128 --lens=300,120` — defaults to the tall slab used by the rim scans. */
function lensOption() {
  const [w, h] = str('size', '200x420').split('x').map(Number)
  const [x, y] = str('lens', '240,60').split(',').map(Number)
  return { w, h, r: flag('radius', 48), x, y }
}

if (mode === 'map') runMap()
else if (mode === 'render')
  await runRender({
    dpr: flag('dpr', 1),
    blur: flag('blur', 0),
    bezel: flag('bezel', 18),
    scale: flag('scale', 1),
    probe: str('probe', 'ruler'),
    compensate: has('compensate'),
    search: flag('search', 12),
    lens: lensOption(),
    bg: str('bg', 'ruler'),
    headed: has('headed'),
    gpu: has('gpu'),
    depth: has('depth'),
    amounts: (
      str('amounts', '0,2,4,6,8,10,14,18,22,32,48')
    )
      .split(',')
      .map(Number)
  })
else {
  console.error(
    'usage: refraction-probe.mjs map\n' +
      '       refraction-probe.mjs render [--dpr=1] [--probe=ruler|shift|field] [--bg=ruler|checker|noise|xy] ' +
      '[--blur=0] [--bezel=18] [--scale=1] [--size=256x256] [--radius=128] [--lens=x,y] [--search=12] ' +
      '[--amounts=…] [--depth] [--headed] [--gpu]'
  )
  process.exit(2)
}
