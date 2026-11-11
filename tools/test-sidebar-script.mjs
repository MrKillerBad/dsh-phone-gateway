/**
 * Extracts the injected sidebar script from the Java source and syntax-checks it.
 *
 * The handle's JavaScript lives as Java string concatenation, so a broken escape
 * or a stray quote is invisible to javac and only shows up on the phone as a
 * silently missing control. This reconstructs the exact string Java would build
 * and runs it through the JS parser.
 *
 * It also asserts the invariants that already broke once:
 *   - the node is appended to the document before place() looks it up by id
 *   - place() can render the handle even when no column is found
 *   - the observer does not watch childList (streaming tokens would spam it)
 *
 * Run:  node tools/test-sidebar-script.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', 'android', 'src', 'com', 'dsh', 'lan', 'MainActivity.java')
const PANEL = join(here, '..', 'dsh-phone-gateway', 'client.js')
const panelSource = readFileSync(PANEL, 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

/** Decode the subset of Java string escapes this file uses. */
function decodeJavaLiteral(raw) {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = raw[index + 1]
    index += 1
    switch (next) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case 'u': {
        const hex = raw.slice(index + 1, index + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`
          index += 4
          break
        }
        out += String.fromCharCode(parseInt(hex, 16))
        index += 4
        break
      }
      default: out += next
    }
  }
  return out
}

/**
 * Read one `private static final String NAME = ...;` declaration as Java would
 * evaluate it.
 *
 * The declaration mixes string literals with a bare identifier reference
 * (`+ SIDEBAR_COLUMN_JS +`), and carries `//` comments between the concatenated
 * pieces. A naive literal-collection drops both, producing a script that is
 * missing half its code — which is exactly what the first version of this test
 * reported. So the declaration is tokenized properly: comments skipped, literals
 * decoded, and the identifier substituted with its own value.
 */
function readConstant(source, name, resolve = () => undefined) {
  const start = source.indexOf(`String ${name} =`)
  if (start === -1) return undefined
  // The source is CRLF, so `\n\n` never matches a blank line: searching for it
  // silently ran the slice to EOF and pulled in every later method.
  const terminator = /\r?\n\r?\n/.exec(source.slice(start))
  const end = terminator === null ? source.length : start + terminator.index
  const declaration = source.slice(start, end)

  let out = ''
  let index = 0
  while (index < declaration.length) {
    const char = declaration[index]

    if (char === '/' && declaration[index + 1] === '/') {
      const newline = declaration.indexOf('\n', index)
      index = newline === -1 ? declaration.length : newline + 1
      continue
    }
    if (char === '/' && declaration[index + 1] === '*') {
      const close = declaration.indexOf('*/', index)
      index = close === -1 ? declaration.length : close + 2
      continue
    }

    if (char === '"') {
      let cursor = index + 1
      let raw = ''
      while (cursor < declaration.length) {
        const inner = declaration[cursor]
        if (inner === '\\') {
          raw += inner + (declaration[cursor + 1] ?? '')
          cursor += 2
          continue
        }
        if (inner === '"') break
        raw += inner
        cursor += 1
      }
      out += decodeJavaLiteral(raw)
      index = cursor + 1
      continue
    }

    if (/[A-Za-z_]/.test(char)) {
      let cursor = index
      while (cursor < declaration.length && /[A-Za-z0-9_]/.test(declaration[cursor])) cursor += 1
      const identifier = declaration.slice(index, cursor)
      if (identifier !== 'String' && identifier !== name) {
        const replacement = resolve(identifier)
        if (replacement !== undefined) out += replacement
      }
      index = cursor
      continue
    }

    index += 1
  }
  return out
}

const source = readFileSync(SOURCE, 'utf8')
const columnJs = readConstant(source, 'SIDEBAR_COLUMN_JS')
const handleJs = readConstant(source, 'SIDEBAR_HANDLE_SCRIPT', (identifier) =>
  identifier === 'SIDEBAR_COLUMN_JS' ? columnJs : undefined,
)

console.log('1) both constants were found and decoded')
check('SIDEBAR_COLUMN_JS extracted', typeof columnJs === 'string' && columnJs.length > 100)
check('SIDEBAR_HANDLE_SCRIPT extracted', typeof handleJs === 'string' && handleJs.length > 400)

if (columnJs === undefined || handleJs === undefined) {
  console.log('\nCANNOT CONTINUE')
  process.exit(1)
}

console.log('2) the reconstructed script parses as JavaScript')
let parseError = null
try {
  // Parse only: the IIFE never runs here, so DOM APIs are irrelevant.
  new Function(handleJs)
} catch (error) {
  parseError = error
}
check('no syntax error', parseError === null, parseError === null ? '' : String(parseError))

console.log('3) the rewritten source contains both halves')
check('column helper is embedded', handleJs.includes('function isSidebar'))
check('handle builder is embedded', handleJs.includes('dsh-phone-gateway-sidebar-handle'))

console.log('4) the append-before-place bug stays fixed')
{
  const appendAt = handleJs.indexOf('document.body.appendChild(handle)')
  const placeAt = handleJs.indexOf('document.body.appendChild(handle)')
  check('handle is appended to the document', appendAt !== -1)
  // place() looks the node up by id, so the append has to come first in build().
  const buildStart = handleJs.indexOf('function build()')
  const firstPlaceCall = handleJs.indexOf('place()', buildStart)
  check('append precedes the first place() call in build()', appendAt !== -1 && firstPlaceCall > appendAt)
}

console.log('5) the handle sits INSIDE the column, near its right edge')
{
  check('absolute positioning', handleJs.includes("'position:absolute'"))
  check('anchored inside the column', handleJs.includes('col.appendChild(handle)'))
  check('small right gap', handleJs.includes("var GAP = 5") && handleJs.includes("GAP + 'px'"))
  // `right: -11px` straddled the border and was clipped by an overflow ancestor.
  check('no negative right offset', !handleJs.includes("right = '-"))
  check('no fixed overlay', !handleJs.includes("'position:fixed'"))
}

console.log('6) the observer does not choke on streaming DOM churn')
{
  check('no childList observation', !handleJs.includes('childList: true'))
  check('class-only attribute filter', handleJs.includes("attributeFilter: ['class']"))
}

console.log('7) size is thumb-friendly')
{
  check('30px wide', handleJs.includes("'width:30px'"))
  check('96px tall', handleJs.includes("'height:96px'"))
}

console.log('8) the column is resolved once and cached')
{
  check('resolve() caches', handleJs.includes('if (resolved && resolved.isConnected) return resolved'))
  check('place() uses resolve()', handleJs.includes('var col = resolve()'))
  check('place() does not walk the DOM itself', !handleJs.includes('var col = column()'))
}

console.log('9) no scripted follow loop')
{
  // Following must come from the browser's own layout, not from per-frame writes.
  check('no requestAnimationFrame', !handleJs.includes('requestAnimationFrame'))
  check('no ResizeObserver juggling', !handleJs.includes('ResizeObserver'))
}

console.log('10) the handle is only injected into the DSH app page')
{
  // The gateway serves its own HTML for pairing and device management. Injecting
  // there left a stranded control floating over the pairing form.
  check('a page test exists', source.includes('SCRIPT_IS_DSH_PAGE'))
  check('it keys on the boot payload', /SCRIPT_IS_DSH_PAGE[\s\S]{0,320}__DSH_BOOT__/.test(source))
  check('installation is gated by it', /installSidebarHandleWhenReady[\s\S]{0,600}SCRIPT_IS_DSH_PAGE/.test(source))
}

console.log('11) the handle stays BELOW every panel this plugin opens')
{
  // A cross-file invariant, and one that already broke: the handle sat at
  // 2147483001 while the gateway panel's backdrop was 2147483000, so the handle
  // punched through the dialog. The handle belongs to the sidebar's layer, so any
  // overlay the shell or this plugin opens must be able to cover it.
  const handleZ = Number(/z-index:(\d+)'/.exec(source)?.[1] ?? 'NaN')
  check('the handle declares a z-index', Number.isFinite(handleZ), String(handleZ))

  const overlayZs = [...panelSource.matchAll(/zIndex:\s*(\d+)/g)].map((entry) => Number(entry[1]))
  check('the panel declares at least one z-index', overlayZs.length > 0, String(overlayZs.length))

  const highestHandle = Math.max(...[handleZ].filter(Number.isFinite))
  for (const overlayZ of overlayZs) {
    check(
      `handle (${String(highestHandle)}) is below panel overlay (${String(overlayZ)})`,
      highestHandle < overlayZ,
      `${String(highestHandle)} >= ${String(overlayZ)}`,
    )
  }
  // A "max int" value is a symptom of fighting the shell rather than cooperating.
  check('the handle does not use an absurd z-index', highestHandle < 1000, String(highestHandle))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
