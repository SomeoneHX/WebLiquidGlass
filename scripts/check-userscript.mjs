/**
 * `npm run check:userscript` — the invariants a plain `node --check` cannot reach.
 *
 * The installed artifact is generated (section 1 of the file is `src/core/glass-filter.ts` with
 * the types stripped), hand-maintained at both ends, and *concatenated* by whoever `@require`s
 * it. That combination is where the silent failures live, so this checks four things:
 *
 *   1. it parses at all;
 *   2. it is safe to concatenate at the **front** — the first statement is guarded by a leading
 *      `;`. This one matters because a statement starting with `(` is exactly the token ASI will
 *      not separate from the line above: `someCall()` becomes `someCall()(function () { … })()`.
 *      It is checked as a **textual** invariant, deliberately: the merged program is perfectly
 *      valid JavaScript, so no parser can tell the two apart — only the source can;
 *   3. it is safe to concatenate at the **back** — the closing `})()` is terminated, or a
 *      following statement beginning with `(` is swallowed by it. Same reasoning;
 *   4. the two carriers of the version agree (`@version` and `const VERSION`), so a stamping run
 *      that rewrites only one of them cannot go unnoticed.
 *
 * Pure Node, zero dependencies, no browser.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'userscript/liquid-glass-refract.user.js'
const source = readFileSync(join(ROOT, FILE), 'utf8')

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

// ---- 1. it parses -----------------------------------------------------------------------------
try {
  new vm.Script(source, { filename: FILE })
} catch (error) {
  failures.push(`does not parse: ${error.message}`)
}

/**
 * The first line that is actually code, skipping blanks, `//` comments and `/* … *\/` blocks.
 * Crude on purpose: a line that mixes a comment and a statement on one line would be misread,
 * and that is fine — this file does not, and being told about it is the useful outcome.
 */
function firstCodeLine(text) {
  const lines = text.split('\n')
  let block = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (block) {
      const close = line.indexOf('*/')
      if (close === -1) continue
      block = false
      const rest = line.slice(close + 2).trim()
      if (rest && !rest.startsWith('//')) return { n: i + 1, text: rest }
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) continue
    if (trimmed.startsWith('/*')) {
      const close = trimmed.indexOf('*/')
      if (close === -1) { block = true; continue }
      const rest = trimmed.slice(close + 2).trim()
      if (rest && !rest.startsWith('//')) return { n: i + 1, text: rest }
      continue
    }
    return { n: i + 1, text: trimmed }
  }
  return null
}

// ---- 2. the front edge ------------------------------------------------------------------------
const first = firstCodeLine(source)
check(first !== null, 'no executable statement found')
if (first) {
  check(
    first.text === ';(function () {',
    `the first statement (line ${first.n}) is ${JSON.stringify(first.text)} — it must be ` +
      `';{IIFE}' guarded by a leading ';', or concatenating this file after an expression ` +
      `silently merges the two`
  )
}

// ---- 3. the back edge -------------------------------------------------------------------------
const lastLine = source.replace(/\s+$/, '').split('\n').pop()
check(
  lastLine === '})();',
  `the file ends with ${JSON.stringify(lastLine)} — the closing '})()' must be terminated with ` +
    `';', or a following statement that starts with '(' is absorbed by it`
)

// ---- 4. version carriers ----------------------------------------------------------------------
const declared = /^\/\/ @version\s+(\S+)\s*$/m.exec(source)
const literal = /^[ \t]*const VERSION = '([^']+)'/m.exec(source)
check(declared !== null, 'no "@version" line in the metadata block')
check(literal !== null, "no `const VERSION = '...'` in the body")
if (declared && literal) {
  check(
    declared[1] === literal[1],
    `version carriers disagree: @version ${declared[1]} vs const VERSION ${literal[1]}`
  )
}

// ---- report -----------------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`✗ ${FILE}`)
  for (const failure of failures) console.error(`    ${failure}`)
  process.exit(1)
}
console.log(`✓ ${FILE}`)
console.log(`    parses; front edge guarded at line ${first.n}; back edge '${lastLine}';`)
console.log(`    version ${declared[1]} declared once and carried twice`)
