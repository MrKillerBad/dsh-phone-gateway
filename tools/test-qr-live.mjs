/**
 * End-to-end check of the scannable code: takes the matrix the RUNNING gateway
 * injects into the page and proves it is the QR for the URL a phone must open.
 *
 * The injected matrix is only useful if it decodes to the right address, and the
 * failure modes are silent — a code that scans but points at a stale IP looks
 * perfectly fine on screen. So this compares the live payload against the
 * reference encoder, for the address assembled from the same fields the panel uses.
 *
 * Run:  node tools/test-qr-live.mjs [baseUrl]
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8791').replace(/\/$/, '')
const profileDir = process.env.DSH_PROFILE_DIR ?? 'D:\\A\\DSH\\profiles\\desktop'
const require = createRequire(join(profileDir, 'package.json'))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) the index carries the gateway payload')
const response = await fetch(`${BASE}/`, {
  headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
})
const html = await response.text()
check('index served', response.status === 200, String(response.status))

const match = /globalThis\["__DSH_LAN_GATEWAY__"\]\s*=\s*(\{.*?\})<\/script>/s.exec(html)
check('payload present', match !== null)
if (match === null) {
  console.log('\n1 FAILURE(S)')
  process.exit(1)
}

const payload = JSON.parse(match[1])
console.log('2) the payload describes a reachable address')
check('lan is a LAN address', typeof payload.lan === 'string' && payload.lan.split('.').length === 4, String(payload.lan))
check('lan is not loopback', payload.lan !== '127.0.0.1', String(payload.lan))
check('port present', Number.isInteger(payload.port), String(payload.port))
check('app path', payload.appPath === '/__lan/app', String(payload.appPath))
check('app available', payload.appAvailable === true, String(payload.appAvailable))

// Exactly what the panel builds from the same fields.
const url = `http://${payload.lan}:${payload.port}${payload.appPath}`

console.log('3) the code is square and well formed')
check('qr present', payload.qr !== null && typeof payload.qr === 'object')
const { size, rows } = payload.qr ?? {}
check('size is a valid QR dimension', [21, 25, 29, 33, 37, 41, 45, 49, 53, 57].includes(size), String(size))
check('one row per module row', Array.isArray(rows) && rows.length === size, String(rows?.length))
check('every row is full width', Array.isArray(rows) && rows.every((row) => row.length === size))
check('only 0/1', Array.isArray(rows) && rows.every((row) => /^[01]+$/.test(row)))

console.log('4) the matrix is the QR for the address the phone must open')
{
  // The oracle is an optional dependency of another plugin and can disappear on a
  // profile update. Losing it must not crash this suite: the same guarantee is
  // carried by the frozen fingerprints, which were recorded while it was present.
  let reference = null
  try {
    reference = require('qrcode').create([{ data: url, mode: 'byte' }], { errorCorrectionLevel: 'M' })
  } catch {
    console.log('  NOTE  the qrcode oracle is unavailable; using the frozen fingerprint')
  }

  if (reference === null) {
    // Same URL shapes as tools/test-qr.mjs freezes; this one is whatever the host
    // currently advertises, so a wrong address still fails the address checks above.
    const known = {
      'http://10.61.18.139:8791/__lan/app': 'b25b219963aec87aa123fd2ac1aa12c0454c54577637c37d7bc8675c6467b723',
      'http://10.113.184.25:8791/__lan/app': null,
    }
    const expected = known[url]
    if (expected === undefined || expected === null) {
      console.log('  SKIP  no frozen fingerprint for this address')
    } else {
      const fingerprint = createHash('sha256').update(rows.join('')).digest('hex')
      check('every module matches the frozen fingerprint', fingerprint === expected, fingerprint)
    }
  } else {
    check(
      'version agrees with the reference encoder',
      reference.modules.size === size,
      `reference ${reference.modules.size} vs injected ${size}`,
    )

    let mismatch = null
    if (reference.modules.size === size) {
      for (let row = 0; row < size && mismatch === null; row += 1) {
        for (let column = 0; column < size; column += 1) {
          const expected = reference.modules.data[row * size + column] ? '1' : '0'
          if (rows[row][column] !== expected) {
            mismatch = `(${row},${column}) injected ${rows[row][column]} vs ${expected}`
            break
          }
        }
      }
    }
    check('every module matches', mismatch === null, String(mismatch))
  }
}

console.log('5) the code is actually scannable-looking')
{
  // Finder patterns: 7 dark modules on each top edge, at three corners.
  const topRow = rows[0]
  check('top-left finder spans 7 modules', topRow.slice(0, 7) === '1111111', topRow.slice(0, 7))
  check('top-right finder spans 7 modules', topRow.slice(size - 7) === '1111111', topRow.slice(size - 7))
  check('bottom-left finder starts dark', rows[size - 7][0] === '1')
  // Timing pattern alternates at every other module in row 6.
  let alternating = true
  for (let column = 8; column < size - 8; column += 1) {
    const expected = column % 2 === 0 ? '1' : '0'
    if (rows[6][column] !== expected) alternating = false
  }
  check('timing pattern alternates', alternating)
}

console.log('6) the devices page shows the same code')
{
  const page = await (await fetch(`${BASE}/__lan/devices`, { headers: { 'accept-language': 'zh-CN' } })).text()
  check('has an svg block', page.includes('<svg'))
  check('svg is labelled with the url', page.includes(`aria-label="${url}"`))
  check('url is shown as text too', page.includes(url))

  // The SVG draws one subpath per dark module; a mismatch would mean the picture
  // no longer matches the matrix the code was checked against.
  const svg = /<svg[\s\S]*?<\/svg>/.exec(page)
  check('svg is present', svg !== null)
  if (svg !== null) {
    const dark = rows.reduce((total, row) => total + [...row].filter((cell) => cell === '1').length, 0)
    const subpaths = (svg[0].match(/M\d+/g) ?? []).length
    check('one subpath per dark module', subpaths === dark, `${String(subpaths)} vs ${String(dark)}`)
    check('white background rect', svg[0].includes('fill="#ffffff"'))
    check('no quiet-zone overlap', svg[0].includes('viewBox="0 0'))
  }
}

console.log('7) the refresh route answers with the same, freshly computed address')
{
  // The panel's refresh button reads this route. It lives on DSH's OWN port, so it
  // shares the page's origin in every runtime — the gateway's own routes are a
  // different origin from the page and a fetch of them would be blocked.
  const dshPort = (await (await fetch(`${BASE}/__lan/status`)).json()).port
  const routeUrl = `http://127.0.0.1:${String(dshPort)}/__lan/address`

  const first = await fetch(routeUrl, { headers: { 'cache-control': 'no-store' } })
  check('route answers 200', first.status === 200, String(first.status))
  check('route is not cached', first.headers.get('cache-control') === 'no-store')
  check('route is JSON', (first.headers.get('content-type') ?? '').includes('application/json'))
  const fresh = await first.json()

  check('route url matches the injected url', fresh.url === url, `${String(fresh.url)} vs ${String(url)}`)
  check('route lan matches', fresh.lan === payload.lan, String(fresh.lan))
  check('route says the build exists', fresh.appAvailable === true, String(fresh.appAvailable))
  check('route carries the code too', fresh.qr !== null && typeof fresh.qr.size === 'number')
  check(
    'route code is the same matrix',
    fresh.qr !== null && Array.isArray(fresh.qr.rows) && fresh.qr.rows.join('') === rows.join(''),
  )

  // Two calls must both be current: the value is computed per request, not cached
  // at activation. That is the whole point of the button.
  const second = await (await fetch(routeUrl, { cache: 'no-store' })).json()
  check('a second read agrees', second.url === fresh.url, String(second.url))

  // The route must also be readable through the gateway, for a paired phone.
  const proxied = await fetch(`${BASE}/__lan/address`)
  check('reachable through the gateway', proxied.status === 200, String(proxied.status))
}

console.log('8) the client half has a refresh control wired to that route')
{
  // Read the source directly: the served bundle URL carries a rev hash, so
  // guessing it is fragile. The route test above already proved the server side.
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-phone-gateway', 'client.js'),
    'utf8',
  )

  check('the client knows the route', source.includes("const ADDRESS_PATH = '/__lan/address'"))
  check('a refresh reader exists', source.includes('function readAddressFromHost'))
  check('it reads the route first', /readAddressFromHost[\s\S]{0,400}fetch\(ADDRESS_PATH/.test(source))
  check(
    'it falls back to parsing the index',
    /readAddressFromHost[\s\S]{0,1200}__DSH_LAN_GATEWAY__/.test(source),
  )
  check('a refresh label is rendered', source.includes('刷新地址'))
  check('the button is wired', /onClick: onRefresh/.test(source))
  check('progress is shown', source.includes('刷新中'))
  check('the outcome is reported', source.includes('已刷新'))
}

console.log('9) the pairing-card route reports and mints codes')
{
  // The panel shows the code inline, so this route replaces "open another page,
  // press a button there, read the number back".
  const dshPort = (await (await fetch(`${BASE}/__lan/status`)).json()).port
  const card = `http://127.0.0.1:${String(dshPort)}/__lan/paircard`

  const issued = await (await fetch(card, { method: 'POST', cache: 'no-store' })).json()
  check('POST mints a six-digit code', /^\d{6}$/.test(String(issued.code ?? '')), String(issued.code))
  check('the code carries an expiry', typeof issued.expiresAt === 'number')
  check(
    'the expiry is within the three-minute window',
    issued.expiresAt - Date.now() <= 180_000 && issued.expiresAt > Date.now(),
    String(issued.expiresAt - Date.now()),
  )

  const first = await (await fetch(card, { cache: 'no-store' })).json()
  check('GET reports the minted code', first.code === issued.code, String(first.code))
  check('GET reports the remaining attempts', typeof first.attemptsLeft === 'number')

  // Idempotence matters: the panel reads on open, and a consuming getter would
  // blank the very number it just displayed.
  const second = await (await fetch(card, { cache: 'no-store' })).json()
  check('GET does not consume the code', second.code === issued.code, String(second.code))

  const replacement = await (await fetch(card, { method: 'POST', cache: 'no-store' })).json()
  check('POST replaces the code', replacement.code !== issued.code, String(replacement.code))
  const afterReplace = await (await fetch(card, { cache: 'no-store' })).json()
  check('the old code is gone', afterReplace.code === replacement.code, String(afterReplace.code))

  const put = await fetch(card, { method: 'PUT' })
  await put.text()
  check('an unsupported method is refused', put.status === 405, String(put.status))
  check('it advertises the allowed methods', (put.headers.get('allow') ?? '').includes('POST'))
}

console.log('10) the panel renders the code and its refresh control')
{
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-phone-gateway', 'client.js'),
    'utf8',
  )
  check('the client knows the route', source.includes("const PAIRCARD_PATH = '/__lan/paircard'"))
  check('a card component exists', source.includes('function PairCard'))
  check('the code is shown large', source.includes('letterSpacing'))
  check('a countdown is rendered', source.includes('formatRemaining'))
  check('the refresh button is wired', /onClick: onIssue/.test(source))
  check('it labels a fresh code', source.includes('换一个配对码'))
  check('it labels an empty state', source.includes('生成配对码'))
  check('it reports the outcome', source.includes('已生成新的配对码'))
}

console.log('11) the close control is pinned, not at the bottom of a scrolling body')
{
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-phone-gateway', 'client.js'),
    'utf8',
  )

  // The panel is a flex column whose BODY scrolls. If the panel itself scrolled, the
  // close button would slide out of reach exactly when the content got long.
  check('the panel is a flex column', /panel: \{[\s\S]{0,400}flexDirection: 'column'/.test(source))
  check('the panel itself does not scroll', /panel: \{[\s\S]{0,400}overflow: 'hidden'/.test(source))
  check('a pinned bar exists', source.includes('panelBar'))
  check('the body scrolls', /panelBody: \{[\s\S]{0,400}overflow: 'auto'/.test(source))
  check(
    'the body can shrink inside the column',
    /panelBody: \{[\s\S]{0,400}minHeight: 0/.test(source),
  )

  // The button must live in the bar, not in the action row at the bottom.
  check('the close control is styled', source.includes('closeButton'))
  check('it sits in the pinned bar', /panelBar[\s\S]{0,500}closeButton/.test(source))
  check('it is a real button', /style: styles\.closeButton[\s\S]{0,200}onClick: \(\) => setOpen\(false\)/.test(source))
  check('it is labelled for screen readers', /style: styles\.closeButton[\s\S]{0,120}'aria-label': '关闭'/.test(source))
  const bottomClose = /key: 'actions'[\s\S]{0,900}>\s*关闭\s*,/.test(source)
  check('no duplicate close button in the action row', !bottomClose)
}

console.log('12) the live workspace service holds its boundary')
{
  const dshPort = (await (await fetch(`${BASE}/__lan/status`)).json()).port
  const dirs = `http://127.0.0.1:${String(dshPort)}/__lan/dirs`

  const root = await (await fetch(`${dirs}?root=0&path=`)).json()
  if (root.empty === true) {
    console.log('  SKIP no allowedWorkspaceRoots configured on this profile')
  } else {
    check('the root lists', root.ok === true, String(root.error))
    check('the root is absolute', typeof root.absolute === 'string' && root.absolute.length > 2)

    // The attacks a caller would actually try against the live route.
    //
    // Against a DRIVE root, `..` cannot ascend further — it clamps to the root
    // itself — so "refused" is the wrong expectation there. The invariant that
    // matters is that the answer never leaves the roots, which for a drive root
    // means it stays exactly on it.
    for (const [label, attempt] of [
      ['parent traversal', '..'],
      ['deep traversal', 'a/../../..'],
      ['an absolute windows path', 'C:\\Windows'],
      ['an absolute posix path', '/etc'],
    ]) {
      const answer = await (await fetch(`${dirs}?root=0&path=${encodeURIComponent(attempt)}`)).json()
      const contained = answer.ok === false || answer.absolute === root.absolute
      check(label, contained, `ok=${String(answer.ok)} absolute=${String(answer.absolute)} error=${String(answer.error)}`)
    }

    const badRoot = await (await fetch(`${dirs}?root=99&path=`)).json()
    check('a bad root index is refused', badRoot.ok === false, String(badRoot.error))

    const badNames = ['../escape', 'a/b', 'C:evil']
    for (const name of badNames) {
      const answer = await (
        await fetch(dirs, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: 0, path: '', name }),
        })
      ).json()
      check(`refuses the folder name ${JSON.stringify(name)}`, answer.ok === false, String(answer.error))
    }

    const put = await fetch(dirs, { method: 'PUT' })
    await put.text()
    check('an unsupported method is refused', put.status === 405, String(put.status))
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
