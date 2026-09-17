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
    `${body}\n// sdf / gradSdf / clampByte are returned for the band oracle, which re-states the\n  // loop structure under test rather than the maths.\n  return { buildMap, FILTER_PAD, sdf, gradSdf, clampByte };`
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

/**
 * A fixed port range collides with a browser a previous attempt left behind, and the probe then
 * talks to whatever is already listening (`chrome did not expose a debugging endpoint`). That was
 * survivable when a run started one browser; `fidelity` starts one per destination, so retry on a
 * fresh port — but only for that failure, so a real assertion failure is never swallowed.
 */
async function withChrome({ headed, gpu }, fn) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await onceChrome({ headed, gpu }, fn)
    } catch (error) {
      lastError = error
      if (!/debugging endpoint/.test(String(error.message))) throw error
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  throw lastError
}

async function onceChrome({ headed, gpu }, fn) {
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
/* `band` — is the rim-band shortcut still a superset of the rim?                                 */
/* ------------------------------------------------------------------------------------------- */

/**
 * `buildMap` no longer visits every pixel of the padded region: it fills the bitmap with the
 * neutral word and then walks only the rows and columns its SDF bound admits. That is what makes a
 * map build cheap enough to sit inside a press animation, and the bound is a piece of *reasoning* —
 * which can be wrong. A band that is too tight silently drops rim pixels, the refraction goes
 * subtly wrong, and nothing else in the repo notices: the map still encodes, the filter still
 * runs, the tests still pass.
 *
 * So this mode checks the shortcut against a full scan:
 *
 *   node scripts/refraction-probe.mjs band
 *
 * `sdf` / `gradSdf` / `clampByte` come from the shipped core (exposed by `loadCore`), so the oracle
 * re-states only the **loop structure** — the one thing under test — and not the maths. The neutral
 * word is read back out of the shipped bitmap rather than re-derived, so a change to it cannot make
 * the two implementations agree on the wrong answer.
 *
 * History, because both of these were real and both were invisible without this check:
 *   - a bound of `d >= max(qx, qy) - r` is true, but it does not imply `max(qx, qy) >= r - bezel`,
 *     so it drops the diagonals just outside a rounded corner;
 *   - the right edge needs an *inclusive* bound (`x <= w`): `d` is exactly 0 on `x = w`, and 0 is
 *     inside the rim test.
 */

/** The full scan, frozen as the oracle. Every pixel of the padded region is visited. */
function fullScanMap(core, spec, branch, neutral) {
  const w = Math.max(1, Math.round(spec.width))
  const h = Math.max(1, Math.round(spec.height))
  const pad = core.FILTER_PAD
  const cw = w + pad * 2
  const ch = h + pad * 2
  const [tl, tr, br, bl] = spec.cornerRadii
  const bezel = Math.max(0.5, spec.refractionHeight)
  const depth = spec.depthEffect ? 1 : 0
  const hw = w / 2
  const hh = h / 2
  const data = new Uint8ClampedArray(cw * ch * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = neutral[0]
    data[i + 1] = neutral[1]
    data[i + 2] = neutral[2]
    data[i + 3] = neutral[3]
  }

  const rim = []
  let vmax = 0
  for (let j = 0; j < ch; j++) {
    const y = j - pad
    for (let i = 0; i < cw; i++) {
      const x = i - pad
      const d = core.sdf(x, y, w, h, tl, tr, br, bl)
      if (d > 0 || d < -bezel) continue

      const t = Math.min(1, Math.max(0, 1 + d / bezel))
      const falloff = 1 - Math.sqrt(Math.max(0, 1 - t * t))
      let gx =
        core.gradSdf(x + 1, y, w, h, tl, tr, br, bl) - core.gradSdf(x - 1, y, w, h, tl, tr, br, bl)
      let gy =
        core.gradSdf(x, y + 1, w, h, tl, tr, br, bl) - core.gradSdf(x, y - 1, w, h, tl, tr, br, bl)
      let length = Math.hypot(gx, gy)
      if (length > 0) {
        gx /= length
        gy /= length
      }
      if (depth !== 0) {
        const cx = x - hw
        const cy = y - hh
        const centreLength = Math.hypot(cx, cy)
        if (centreLength > 0) {
          gx += cx / centreLength
          gy += cy / centreLength
          length = Math.hypot(gx, gy)
          if (length > 0) {
            gx /= length
            gy /= length
          }
        }
      }
      const dispersion = ((x - hw) * (y - hh)) / (hw * hh)
      const m = falloff * (1 + branch * dispersion)
      if (m > vmax) vmax = m
      rim.push({ index: (j * cw + i) * 4, gx, gy, m })
    }
  }

  const k = vmax > 0 ? 127 / vmax : 0
  for (const pixel of rim) {
    if (pixel.m <= 0) continue
    const s = pixel.m * k
    data[pixel.index] = core.clampByte(128 - pixel.gx * s)
    data[pixel.index + 1] = core.clampByte(128 - pixel.gy * s)
  }
  return { data, vmax, rimPixels: rim.length }
}

/**
 * One shipped `buildMap` run: a fresh core per call, because the module caches its scratch canvas
 * and a second build on the same instance would not hand a new one to the stub.
 */
function shippedMap(spec, branch) {
  const { core, canvases } = loadCore()
  canvases.length = 0
  const entry = core.buildMap(spec, branch)
  const image = canvases[canvases.length - 1]?.image
  if (!image) throw new Error('the core never put an ImageData on its canvas')
  return { core, image, vmax: entry.vmax }
}

/** Shapes chosen to cover every branch of the band bound, including the two that used to fail. */
const BAND_CASES = [
  ['ScrollContainer row', 1408, 160, 32, 16, false],
  ['ScrollContainer row (wide bezel)', 1408, 160, 32, 32, false],
  ['ScrollContainer row (bezel > r)', 1408, 160, 32, 48, false],
  ['LiquidButton', 200, 40, 20, 12, false],
  ['LiquidToggle thumb (capsule)', 64, 28, 14, 5, false],
  ['Toggle thumb, exact numbers', 40, 24, 12, 5, false],
  ['ControlCenter tile', 400, 300, 24, 24, true],
  ['Rectangle (r = 0)', 100, 100, 0, 8, false],
  ['Mixed radii', 300, 200, 30, 16, false],
  ['bezel > r on a small box', 160, 48, 24, 48, false],
  ['Capsule', 50, 50, 25, 25, false],
  ['Large radius, thin bezel', 300, 300, 150, 10, true]
]

function runBand() {
  console.log('\n=== rim-band shortcut vs full scan ===')
  console.log(
    'the shipped buildMap walks only the rows/columns its SDF bound admits; the oracle walks all.\n' +
      'A single differing byte means the bound is no longer a superset of the rim.\n'
  )
  console.log(
    'case                              branch      rim px   bytes   identical   shipped ms   oracle ms'
  )

  let failures = 0
  for (const [name, w, h, r, bezel, depth] of BAND_CASES) {
    const spec = {
      width: w,
      height: h,
      cornerRadii: [r, r, r, r],
      refractionHeight: bezel,
      depthEffect: depth,
      chromaticAberration: r === 0 ? false : true
    }
    // `Mixed radii` keeps its own corners; the tuple above is a single radius everywhere else.
    if (name === 'Mixed radii') spec.cornerRadii = [30, 10, 50, 20]

    for (const branch of [0, 1, -1]) {
      if (!spec.chromaticAberration && branch !== 0) continue

      const shippedStart = process.hrtime.bigint()
      const { core, image } = shippedMap(spec, branch)
      const shippedMs = Number(process.hrtime.bigint() - shippedStart) / 1e6

      // The neutral word, read back from a corner of the padded region: far outside every shape.
      const data = image.data
      const neutral = [data[0], data[1], data[2], data[3]]
      for (const at of [0, 4, (image.width - 1) * 4]) {
        if (data[at] !== neutral[0] || data[at + 1] !== neutral[1] || data[at + 2] !== neutral[2]) {
          throw new Error(`${name}: the padded margin is not a uniform neutral — the oracle's neutral word would be wrong`)
        }
      }

      const oracleStart = process.hrtime.bigint()
      const oracle = fullScanMap(core, spec, branch, neutral)
      const oracleMs = Number(process.hrtime.bigint() - oracleStart) / 1e6

      let firstDiff = -1
      let diffs = 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== oracle.data[i]) {
          if (firstDiff < 0) firstDiff = i
          diffs++
        }
      }
      const identical = diffs === 0
      if (!identical) failures++

      const branchLabel = branch === 0 ? 'green' : branch === 1 ? 'red' : 'blue'
      console.log(
        `${name.padEnd(33)} ${branchLabel.padEnd(6)} ${String(oracle.rimPixels).padStart(8)} ` +
          `${String(data.length).padStart(7)}   ${(identical ? 'yes' : 'NO').padStart(9)}   ` +
          `${shippedMs.toFixed(1).padStart(10)}   ${oracleMs.toFixed(1).padStart(9)}`
      )
      if (!identical) {
        const px = firstDiff >> 2
        console.log(
          `      ✗ ${diffs} differing bytes; first at byte ${firstDiff} (pixel ${px}, ` +
            `x = ${(px % image.width) - core.FILTER_PAD}, y = ${Math.floor(px / image.width) - core.FILTER_PAD})`
        )
      }
    }
  }

  console.log(
    `\n${failures === 0 ? '✓' : '✗'} ${failures === 0 ? 'every case is byte-identical to a full scan' : `${failures} case/branch combinations differ from a full scan`}` +
      '\n  a full scan would pass this test trivially, so the `shipped ms` vs `oracle ms` column\n' +
      '  is worth an eye too: if the two converge, the shortcut has been lost even though the\n' +
      '  output is still correct.\n'
  )
  if (failures > 0) process.exitCode = 1
}

/* ------------------------------------------------------------------------------------------- */
/* `fidelity` — did a change alter a single byte of what the 13 screens render?                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * The optimisations in this repo are all "same output, less work" — a band scan that must be a
 * superset of the rim, no-op writes that must be skipped, decoration canvases that must not be
 * repainted because their content does not depend on where the surface sits. Every one of those is
 * a claim about *equivality*, and none of them is checked by eyeballing a screenshot.
 *
 * This mode fingerprints what the refraction and the glass layers actually produced on every
 * destination, so two builds can be compared field by field:
 *
 *   npm run dev                                               # in another terminal
 *   node scripts/refraction-probe.mjs fidelity --write=/tmp/base.json
 *   ...make a change...
 *   node scripts/refraction-probe.mjs fidelity --baseline=/tmp/base.json
 *
 * It is an A/B tool rather than a pass/fail gate: the hashes cover *map bytes*, so they are stable
 * across runs of the same build (verified) but tied to the renderer version, so a browser update
 * legitimately changes them. Record a baseline, change one thing, compare.
 */

const FIDELITY_DESTINATIONS = [
  'Buttons',
  'Toggle',
  'Slider',
  'Bottom tabs',
  'Dialog',
  'Lock screen (SDF texture)',
  'Control center',
  'Magnifier',
  'Glass playground',
  'Adaptive luminance glass',
  'Progressive blur',
  'Scroll container',
  'Lazy scroll container'
]

const FIDELITY_FINGERPRINT = `(() => {
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return (h >>> 0).toString(16) }
  const images = Array.from(document.querySelectorAll('feImage')).map((e) => {
    const href = e.getAttribute('href') || ''
    return fnv(href) + ':' + href.length
  })
  const lens = Array.from(document.querySelectorAll('.glass-surface__lens')).map((e) => {
    const cs = getComputedStyle(e)
    return [cs.backdropFilter, cs.transform, cs.clipPath, cs.opacity, cs.maskImage].join(' ')
  })
  const canvases = Array.from(document.querySelectorAll('.glass-surface canvas')).map((c) => {
    const cs = getComputedStyle(c)
    // The backing-store dimensions are deliberately absent. Those are the *culling* state: an
    // off-screen surface has had its canvas released, and which surfaces are off screen at the
    // instant of sampling depends on how far the frame loop had got — measured as a real
    // disagreement between two runs of the same build on the 102-surface screen. The CSS box,
    // transform, blend mode and display value are layout-driven and do not move with culling, so
    // they catch a compositing change without also catching the clock. liveCanvases is reported
    // alongside as information, and deliberately not compared.
    return [cs.left, cs.top, cs.width, cs.height, cs.transform, cs.mixBlendMode, cs.display].join(',')
  })
  return {
    surfaces: document.querySelectorAll('.glass-surface').length,
    feImages: images.length,
    maps: fnv(images.join('|')),
    scales: Array.from(document.querySelectorAll('feDisplacementMap')).map((e) => e.getAttribute('scale')).join(','),
    regions: Array.from(document.querySelectorAll('filter')).map((f) => [f.getAttribute('x'), f.getAttribute('y'), f.getAttribute('width'), f.getAttribute('height')].join(',')).join(';'),
    lens: fnv(lens.join('|')),
    canvases: fnv(canvases.join('|')),
    liveCanvases: Array.from(document.querySelectorAll('.glass-surface canvas')).filter((c) => c.width > 0).length
  }
})()`

const FIDELITY_FIELDS = ['surfaces', 'feImages', 'maps', 'scales', 'regions', 'lens', 'canvases']

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms)
    })
  ])
}

async function runFidelity(options) {
  const base = options.url
  try {
    const res = await withTimeout(fetch(base), 4000, `the dev server at ${base}`)
    if (!res.ok) throw new Error(String(res.status))
  } catch (error) {
    throw new Error(
      `no dev server answering at ${base} (${error.message}).\n` +
        'Start one first: `npm run dev`.'
    )
  }

  const report = { url: base, destinations: {} }

  /**
   * One browser per destination, not one per run.
   *
   * Reusing a tab dies on the third or fourth screen: the renderer stops answering
   * `Runtime.evaluate` outright. That is not this script's bug — it reproduces by hand (mount and
   * unmount a handful of glass screens and the tab goes unresponsive), and a fresh browser per
   * screen is the only shape that survives it. Cold start is a couple of seconds, which is nothing
   * next to a fingerprinted screen.
   */
  const failed = []
  for (const destination of FIDELITY_DESTINATIONS) {
    process.stdout.write('  ' + destination.padEnd(28) + ' ')
    let fingerprint
    try {
    fingerprint = await withChrome({ headed: options.headed, gpu: false }, async (cdp) => {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      const send = (method, params) => cdp.send(method, params, sessionId)
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const label = JSON.stringify(destination)

      await send('Page.enable')
      await send('Runtime.enable')
      await send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: options.height,
        deviceScaleFactor: options.dpr,
        mobile: false
      })
      await send('Page.navigate', { url: base })
      await sleep(4000)

      const evaluate = async (expression) => {
        const r = await withTimeout(
          send('Runtime.evaluate', { expression, returnByValue: true }),
          20000,
          'the renderer (' + destination + ')'
        )
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        }
        return r.result?.value
      }

      const pick = (body) =>
        '(() => { const el = Array.from(document.querySelectorAll(".home__item"))' +
        '.find(e => e.textContent.trim() === ' + label + '); ' +
        'if (!el) throw new Error("missing nav item: " + ' + label + '); ' + body + ' })()'

      await evaluate(pick('el.scrollIntoView({ block: "center", behavior: "instant" }); return true'))
      await sleep(400)
      const at = await evaluate(
        pick('const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }')
      )
      for (const type of ['mousePressed', 'mouseReleased']) {
        await withTimeout(
          send('Input.dispatchMouseEvent', {
            type,
            x: at.x,
            y: at.y,
            button: 'left',
            clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0
          }),
          20000,
          'the renderer (' + destination + ', input)'
        )
      }
      await sleep(2000)

      // A fixed scroll offset, so the same rows are on screen in both runs.
      await evaluate(
        '(() => { const el = document.querySelector(".scroll-y"); if (el) el.scrollTop = 600; return true })()'
      )
      await sleep(900)
      return evaluate(FIDELITY_FINGERPRINT)
    })
    } catch (error) {
      failed.push(destination)
      process.stdout.write('FAILED — ' + error.message + '\n')
      continue
    }
    report.destinations[destination] = fingerprint
    process.stdout.write(
      'surfaces ' + String(fingerprint.surfaces).padStart(3) +
        '  maps ' + fingerprint.maps +
        '  lens ' + fingerprint.lens +
        '  canvases ' + fingerprint.canvases +
        '  (live ' + fingerprint.liveCanvases + ')\n'
    )
  }

  const total = (d) => FIDELITY_FIELDS.map((f) => d[f]).join('|')

  if (options.baseline) {
    let baseline
    try {
      baseline = JSON.parse(readFileSync(options.baseline, 'utf8'))
    } catch (error) {
      throw new Error(`could not read --baseline=${options.baseline} (${error.message})`)
    }
    console.log(`\n=== fidelity vs ${options.baseline} ===\n`)
    let differing = 0
    for (const destination of FIDELITY_DESTINATIONS) {
      const before = baseline.destinations?.[destination]
      const after = report.destinations[destination]
      if (!before) {
        console.log(`  ${destination.padEnd(28)} (absent from the baseline)`)
        continue
      }
      const bad = FIDELITY_FIELDS.filter((f) => String(before[f]) !== String(after[f]))
      if (bad.length === 0) {
        console.log(`  ${destination.padEnd(28)} identical   maps ${after.maps}  lens ${after.lens}  canvases ${after.canvases}`)
      } else {
        differing++
        console.log(`  ${destination.padEnd(28)} DIFFERS     ${bad.join(', ')}`)
        for (const f of bad) console.log(`      ${f}: ${before[f]} -> ${after[f]}`)
      }
    }
    const beforeTotal = new Set(Object.values(baseline.destinations ?? {}).map(total)).size
    console.log(
      `\n${differing === 0 ? '✓' : '✗'} ${differing === 0 ? 'no destination changed' : `${differing} destination(s) changed`}` +
        `  (baseline covers ${Object.keys(baseline.destinations ?? {}).length} destinations, ${beforeTotal} distinct fingerprints)\n`
    )
    if (differing > 0) process.exitCode = 1
  } else {
    console.log('\n=== fidelity fingerprint ===')
    console.log('(record one with --write=<file>, then compare a change with --baseline=<file>)\n')
    for (const destination of FIDELITY_DESTINATIONS) {
      const d = report.destinations[destination]
      console.log(
        `  ${destination.padEnd(28)} surfaces ${String(d.surfaces).padStart(3)}  maps ${d.maps}  scales [${d.scales.slice(0, 28)}]  lens ${d.lens}  canvases ${d.canvases}`
      )
    }
    console.log('')
  }

  if (failed.length > 0) {
    console.log(
      `\n✗ ${failed.length} destination(s) could not be fingerprinted: ${failed.join(', ')}` +
        '\n  a skipped destination is not a pass — the comparison below only covers what ran.\n'
    )
    process.exitCode = 1
  }

  if (options.write) {
    writeFileSync(options.write, JSON.stringify(report, null, 2))
    console.log(`wrote ${options.write}\n`)
  }
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
else if (mode === 'band') runBand()
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
else if (mode === 'fidelity')
  await runFidelity({
    url: str('url', 'http://127.0.0.1:5173/'),
    dpr: flag('dpr', 2),
    width: flag('width', 1440),
    height: flag('height', 900),
    baseline: str('baseline', null),
    write: str('write', null),
    headed: has('headed')
  })
else {
  console.error(
    'usage: refraction-probe.mjs map\n' +
      '       refraction-probe.mjs band\n' +
      '       refraction-probe.mjs fidelity [--url=http://127.0.0.1:5173/] [--baseline=<file>] [--write=<file>]\n' +
      '       refraction-probe.mjs render [--dpr=1] [--probe=ruler|shift|field] [--bg=ruler|checker|noise|xy] ' +
      '[--blur=0] [--bezel=18] [--scale=1] [--size=256x256] [--radius=128] [--lens=x,y] [--search=12] ' +
      '[--amounts=…] [--depth] [--headed] [--gpu]'
  )
  process.exit(2)
}
