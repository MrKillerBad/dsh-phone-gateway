/**
 * Probes the installer route's HTTP semantics.
 *
 * Run:  node tools/test-app-route.mjs [baseUrl]
 *
 * Checks the download route end to end: the bytes match the built APK, the
 * MIME/disposition headers let Android install it, HEAD behaves, conditional
 * requests answer 304, and non-GET methods are refused.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8791').replace(/\/$/, '')
const APK = join(here, '..', 'android', 'build', 'dsh-phone-gateway.apk')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

const url = `${BASE}/__lan/app`

console.log('1) a plain GET returns the installer')
const first = await fetch(url)
const bytes = Buffer.from(await first.arrayBuffer())
check('status 200', first.status === 200, String(first.status))
check(
  'content-type is the Android package MIME',
  first.headers.get('content-type') === 'application/vnd.android.package-archive',
  String(first.headers.get('content-type')),
)
check(
  'content-disposition is an attachment',
  (first.headers.get('content-disposition') ?? '').startsWith('attachment;'),
  String(first.headers.get('content-disposition')),
)
check(
  'content-length matches the body',
  first.headers.get('content-length') === String(bytes.length),
  `${String(first.headers.get('content-length'))} vs ${String(bytes.length)}`,
)

console.log('2) the bytes are the built APK, byte for byte')
{
  let expected = null
  try {
    expected = await readFile(APK)
  } catch {
    console.log('     (skipped: no local build to compare)')
  }
  if (expected !== null) {
    const want = createHash('sha256').update(expected).digest('hex')
    const got = createHash('sha256').update(bytes).digest('hex')
    check('sha256 matches android/build/dsh-phone-gateway.apk', want === got, `${got} vs ${want}`)
  }
}

console.log('3) an APK zip starts with the local-file signature')
{
  // An HTML error page or a truncated stream would not start with "PK".
  check('first two bytes are PK', bytes[0] === 0x50 && bytes[1] === 0x4b)
}

console.log('4) conditional requests answer 304')
{
  const etag = first.headers.get('etag')
  check('etag present', typeof etag === 'string' && etag.startsWith('"'), String(etag))
  const again = await fetch(url, { headers: { 'if-none-match': etag } })
  // Drain so the connection is reusable.
  await again.arrayBuffer()
  check('same etag → 304', again.status === 304, String(again.status))
  const other = await fetch(url, { headers: { 'if-none-match': '"stale"' } })
  await other.arrayBuffer()
  check('different etag → 200', other.status === 200, String(other.status))
}

console.log('5) HEAD answers without a body')
{
  const head = await fetch(url, { method: 'HEAD' })
  const body = await head.arrayBuffer()
  check('status 200', head.status === 200, String(head.status))
  check('empty body', body.byteLength === 0, String(body.byteLength))
  check(
    'still advertises the length',
    head.headers.get('content-length') === String(bytes.length),
    String(head.headers.get('content-length')),
  )
}

console.log('6) other methods are refused')
{
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(url, { method })
    await response.arrayBuffer()
    check(`${method} → 405`, response.status === 405, String(response.status))
  }
}

console.log('7) every response writer refuses to write twice')
{
  // `writeHead` throws ERR_HTTP_HEADERS_SENT once a status line is out, and a throw
  // inside a `.catch` becomes an unhandled rejection — which kills the HOST process,
  // not just this request. That is exactly how DSH died twice before, so the writers
  // themselves guard instead of trusting every call site.
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-phone-gateway', 'index.js'),
    'utf8',
  )

  check('a shared guard exists', source.includes('function alreadyAnswered('))
  check('it checks headersSent', /alreadyAnswered[\s\S]{0,200}headersSent/.test(source))
  for (const writer of ['writeJson', 'writeText', 'writeHtml']) {
    check(`${writer} consults the guard first`, new RegExp(`${writer}\\(res, status[^)]*\\) \\{\\n  if \\(alreadyAnswered\\(res\\)\\) return`).test(source))
  }

  // A request without a Host header (HTTP/1.0) must not build `http://undefined/...`.
  check('the download link falls back to a real authority', /req\.headers\.host !== ''[\s\S]{0,200}\$\{peer\}:\$\{String\(config\.port\)\}/.test(source))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
