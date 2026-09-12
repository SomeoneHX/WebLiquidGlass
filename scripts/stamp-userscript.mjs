#!/usr/bin/env node
/**
 * Stage the extracted userscript into the GitHub Pages artifact.
 *
 * Why this exists rather than a bare `cp`: an installed userscript only auto-updates when the
 * `@version` its manager re-fetches from `@updateURL` differs from the installed one, and GitHub
 * Pages serves a plain static file with no notion of a release. So the *served* copy has its
 * version stamped from the CI run number — every push to `main` becomes a new version and
 * Tampermonkey picks it up on its next check. The repository copy keeps the hand-maintained base
 * version, and this script is the only place the two are allowed to differ.
 *
 * Usage (CI):    node scripts/stamp-userscript.mjs <run-number> dist/liquid-glass-refract.user.js
 * Usage (local): node scripts/stamp-userscript.mjs 0 /tmp/liquid-glass-refract.user.js
 *
 * The stamped version is `<base major.minor>.<run-number>`: base `0.2.0` + run `37` -> `0.2.37`.
 * Both carriers of the version (the metadata line and `const VERSION`) are rewritten, and the
 * result is asserted — a mismatch between them would silently disable the script's own load
 * guard, which is exactly the kind of bug that only shows up as "the API object is the wrong
 * instance" much later.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [runNumber, outPath] = process.argv.slice(2)
if (!runNumber || !outPath) {
  console.error('usage: node scripts/stamp-userscript.mjs <run-number> <out-path>')
  process.exit(2)
}

const SOURCE = resolve('userscript/liquid-glass-refract.user.js')
const source = readFileSync(SOURCE, 'utf8')

const versionLine = /^(\/\/ @version\s+)(\S+)\s*$/m
const literal = /^(\s*const VERSION = ')([^']+)('.*)$/m

const meta = source.match(versionLine)
const code = source.match(literal)
if (!meta) {
  console.error(`no "@version" line in ${SOURCE}`)
  process.exit(1)
}
if (!code) {
  console.error(`no "const VERSION = '...'" line in ${SOURCE}`)
  process.exit(1)
}
if (meta[2] !== code[2]) {
  console.error(`version carriers disagree: @version ${meta[2]} vs const VERSION ${code[2]}`)
  process.exit(1)
}

const base = meta[2]
const majorMinor = base.split('.').slice(0, 2).join('.')
const version = `${majorMinor}.${runNumber}`

const stamped = source
  .replace(versionLine, `$1${version}`)
  .replace(literal, `$1${version}$3`)

if (!new RegExp(`^// @version\\s+${version.replace(/\./g, '\\.')}$`, 'm').test(stamped)) {
  console.error('stamped @version line not found in the output')
  process.exit(1)
}
if (!stamped.includes(`const VERSION = '${version}'`)) {
  console.error('stamped VERSION literal not found in the output')
  process.exit(1)
}

const target = resolve(outPath)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, stamped)

const bytes = Buffer.byteLength(stamped)
const sha = createHash('sha256').update(stamped).digest('hex').slice(0, 16)
console.log(`staged ${base} -> ${version}`)
console.log(`  ${target}`)
console.log(`  ${bytes} bytes, sha256:${sha}`)
