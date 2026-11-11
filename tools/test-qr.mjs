/**
 * Proves the hand-written QR encoder in lib/qr.js correct.
 *
 * The oracle is the `qrcode` package that already ships inside this profile (a
 * dependency of another plugin). It is loaded ONLY here — the gateway must not
 * depend on it — and its matrix is compared module for module, including the mask
 * choice, which only matches if the penalty scoring is also right.
 *
 * Run:  node tools/test-qr.mjs
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeQr, qrRows } from '../dsh-phone-gateway/lib/qr.js'

const here = dirname(fileURLToPath(import.meta.url))
const profileDir = process.env.DSH_PROFILE_DIR ?? 'D:\\A\\DSH\\profiles\\desktop'
const require = createRequire(join(profileDir, 'package.json'))

let oracle = null
try {
  oracle = require('qrcode')
} catch (error) {
  // The oracle is an optional dependency of ANOTHER plugin, so a profile update can
  // remove it. Skipping the whole file would leave the encoder untested, so only the
  // comparison sections are skipped — the frozen-matrix and structural checks below
  // always run.
  console.log(`NOTE  the qrcode oracle is unavailable (${error.message});`)
  console.log('      skipping the module-for-module comparison, keeping the frozen matrices.')
}

const hasOracle = oracle !== null

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
  return false
}

/** Compare our matrix with the oracle's; returns null on a match, else a reason. */
function mismatchOf(text, ecLevel) {
  const ours = encodeQr(text, { ecLevel })
  // The oracle auto-picks the most compact mode (numeric/alphanumeric), which is
  // a DIFFERENT codeword stream for the same string. This encoder is byte-only on
  // purpose — a URL carries lowercase, which no other mode can express — so the
  // oracle is forced to byte mode to make the comparison apples to apples.
  const theirs = oracle.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: ecLevel })

  if (ours.version !== theirs.version) {
    return `version: ours v${ours.version} vs v${theirs.version}`
  }
  if (ours.size !== theirs.modules.size) {
    return `size: ours ${ours.size} vs ${theirs.modules.size}`
  }
  const size = ours.size
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const mine = ours.modules[row][col]
      const reference = theirs.modules.data[row * size + col] ? 1 : 0
      if (mine !== reference) return `module (${row},${col}): ours ${mine} vs ${reference}`
    }
  }
  return null
}

/** One labelled case; the label is shortened so the log stays readable. */
function compare(label, text, ecLevel) {
  if (!hasOracle) return
  const reason = mismatchOf(text, ecLevel)
  return check(label, reason === null, String(reason))
}

console.log(hasOracle ? '1) short payloads' : '1) short payloads — SKIPPED (no oracle)')
const short = ['a', 'AB', 'hello', 'https://example.com', '0123456789', 'DSH-PHONE-GATEWAY']
for (const text of short) {
  compare(`encode ${JSON.stringify(text)}`, text, 'M')
}

console.log(hasOracle ? '2) the real download URLs' : '2) the real download URLs — SKIPPED (no oracle)')
const urls = [
  'http://10.61.18.139:8791/__lan/app',
  'http://10.113.184.25:8791/__lan/app',
  'http://192.168.1.7:8791/__lan/app',
  'http://172.16.0.42:8791/__lan/app',
  'http://10.0.0.1:8791/__lan/app',
]
for (const url of urls) {
  compare(`encode ${url}`, url, 'M')
  // The real use case must stay small enough to scan comfortably on a phone.
  const code = encodeQr(url, { ecLevel: 'M' })
  check(`  ${url} stays at version <= 4`, code.version <= 4, `v${code.version}`)
}

console.log(hasOracle ? '3) every size across the version range' : '3) every size — SKIPPED (no oracle)')
{
  // 1 to 100 bytes at level M walks versions 1..10; each must match exactly.
  for (let length = 1; length <= 100; length += 7) {
    compare(`length ${length}`, 'x'.repeat(length), 'M')
  }
}

console.log(hasOracle ? '4) level L as well' : '4) level L — SKIPPED (no oracle)')
{
  compare('level L short', 'a', 'L')
  compare('level L url', 'http://10.61.18.139:8791/__lan/app', 'L')
  compare('level L long', 'y'.repeat(60), 'L')
}

console.log(hasOracle ? '5) non-ASCII payloads go through UTF-8' : '5) non-ASCII — SKIPPED (no oracle)')
{
  for (const text of ['局域网', 'http://10.61.18.139:8791/__lan/应用', 'café', '🌐']) {
    compare(`encode ${text}`, text, 'M')
  }
}

console.log('6) the quiet-zone-free matrix is what the UI expects')
{
  const code = encodeQr('http://10.61.18.139:8791/__lan/app', { ecLevel: 'M' })
  check('square', code.modules.length === code.size)
  check('rows are full', code.modules.every((row) => row.length === code.size))
  check('only 0/1', code.modules.every((row) => row.every((cell) => cell === 0 || cell === 1)))
  check('has three finder corners', code.modules[0][0] === 1 && code.modules[0][code.size - 1] === 1)
  check('top-right finder is a corner', code.modules[0][code.size - 7] === 1)
  check('bottom-left finder is a corner', code.modules[code.size - 7][0] === 1)
}

console.log('7) frozen matrices: the encoder still produces the audited output')
{
  // These hashes were recorded while the `qrcode` oracle was still installed, and
  // every one of them matched it module for module. The oracle is an optional
  // dev dependency of another plugin and can vanish on a profile update, so the
  // fingerprints carry the guarantee afterwards: any drift in the mode bits, the
  // Reed-Solomon remainder, the masking or the penalty scoring changes the hash.
  const golden = [
    { text: 'http://10.61.18.139:8791/__lan/app', level: 'M', version: 3, hash: 'b25b219963aec87aa123fd2ac1aa12c0454c54577637c37d7bc8675c6467b723' },
    { text: 'http://192.168.1.7:8791/__lan/app', level: 'M', version: 3, hash: '87d8fb3673482b2f0228dc52eef2406c58730d1fc18404ca81058db316cc7b15' },
    { text: 'DSH-PHONE-GATEWAY', level: 'M', version: 2, hash: '6b5afebb740ad16ad2cf4472670d7c81497c070a708500236959fe495b50dfc2' },
    { text: 'http://10.61.18.139:8791/__lan/app', level: 'L', version: 3, hash: 'f50ed82d579aa63867ed4b29a7bcdfb0928e87bea8430010e28fcf810eb0e149' },
  ]
  for (const entry of golden) {
    const code = encodeQr(entry.text, { ecLevel: entry.level })
    const fingerprint = createHash('sha256').update(qrRows(code).join('')).digest('hex')
    check(
      `${entry.text.slice(0, 32)} (${entry.level}) unchanged`,
      fingerprint === entry.hash,
      `${fingerprint}`,
    )
    check(`  version still ${String(entry.version)}`, code.version === entry.version, `v${code.version}`)
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
