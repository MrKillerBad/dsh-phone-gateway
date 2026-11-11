/**
 * The panel's address resolution, exercised against every runtime that renders it.
 *
 * This exists because of a real regression: the panel decided "am I on the LAN?"
 * from the hostname alone, so the DESKTOP SHELL — whose origin is the custom
 * protocol `dsh-app://app` — was classified as a phone and the download link came
 * out as `dsh-app://app/__lan/app`, which nothing can open.
 *
 * Run:  node tools/test-panel-origin.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'dsh-phone-gateway', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

/** Pull a top-level helper out of client.js and make it callable here. */
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`cannot find ${name} in client.js`)
  // Walk braces from the first '{' after the signature.
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

/** The same constants client.js declares. */
const GATEWAY_PORT = '8791'
const STATUS_PATH = '/__lan/status'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// eslint-disable-next-line no-new-func
const gatewayOrigin = new Function(
  'GATEWAY_PORT',
  'LOOPBACK_HOSTS',
  `${extractFunction('gatewayOrigin')}; return gatewayOrigin;`,
)(GATEWAY_PORT, LOOPBACK_HOSTS)

/** Run `gatewayOrigin` against a synthetic location. */
function originAt(protocol, hostname, port) {
  const saved = globalThis.window
  globalThis.window = { location: { protocol, hostname, port, origin: `${protocol}//${hostname}${port ? `:${port}` : ''}` } }
  try {
    return gatewayOrigin()
  } finally {
    globalThis.window = saved
  }
}

console.log('1) the desktop shell must NOT be treated as a gateway')
{
  // Electron's custom protocol: this is where the bug appeared.
  const origin = originAt('dsh-app:', 'app', '')
  check('dsh-app://app → loopback gateway', origin === 'http://127.0.0.1:8791', origin)
  check('no dsh-app scheme leaks into the link', !origin.startsWith('dsh-app'), origin)
}

console.log('2) a desktop browser at the DSH port uses loopback')
{
  const origin = originAt('http:', '127.0.0.1', '50215')
  check('http://127.0.0.1:50215 → loopback gateway', origin === 'http://127.0.0.1:8791', origin)
  const other = originAt('http:', 'localhost', '64238')
  check('http://localhost:64238 → loopback gateway', other === 'http://127.0.0.1:8791', other)
}

console.log('3) a phone on the gateway port uses its own origin')
{
  const origin = originAt('http:', '10.61.18.139', '8791')
  check('http://10.61.18.139:8791 → same origin', origin === 'http://10.61.18.139:8791', origin)
  const other = originAt('http:', '192.168.1.7', '8791')
  check('http://192.168.1.7:8791 → same origin', other === 'http://192.168.1.7:8791', other)
}

console.log('4) loopback on the gateway port still falls back to 127.0.0.1')
{
  // The operator opening the gateway on the computer itself.
  const origin = originAt('http:', '127.0.0.1', '8791')
  check('loopback is never echoed as the phone address', origin === 'http://127.0.0.1:8791', origin)
}

console.log('5) the app link is built from the gateway origin')
{
  const script = extractFunction('resolveAppInfo')
  check('the panel no longer trusts hostname alone', !script.includes('const onLan'))
  check('it compares the port', script.includes('here.port === GATEWAY_PORT'))
  check('it checks the scheme', script.includes("scheme === 'http'"))
  check('it builds the url from APP_PATH', script.includes('${APP_PATH}'))
}

console.log('6) no hardcoded 127.0.0.1 URL constants remain')
{
  check('no STATUS_URL constant', !source.includes('const STATUS_URL'))
  check('no DEVICES_URL constant', !source.includes('const DEVICES_URL'))
  check('paths are declared as paths', source.includes("const STATUS_PATH = '/__lan/status'"))
  check('no PowerShell-mangled placeholder', !source.includes('window.open(${gatewayOrigin()}, '))
}

// ---- resolveAppInfo: the injected global must win -------------------------
const APP_PATH = '/__lan/app'
const meta = new Function(
  'GATEWAY_PORT',
  'LOOPBACK_HOSTS',
  'APP_PATH',
  'STATUS_PATH',
  'gatewayOrigin',
  `${extractFunction('resolveAppInfo')}; return resolveAppInfo;`,
)(GATEWAY_PORT, LOOPBACK_HOSTS, APP_PATH, STATUS_PATH, gatewayOrigin)

/** Run resolveAppInfo with a stubbed global/window and a fetch that must not fire. */
async function resolveAt(protocol, hostname, port, injected) {
  const savedWindow = globalThis.window
  const savedGlobal = globalThis.__DSH_LAN_GATEWAY__
  const savedFetch = globalThis.fetch
  let fetched = false
  globalThis.window = { location: { protocol, hostname, port, origin: `${protocol}//${hostname}${port ? `:${port}` : ''}` } }
  globalThis.__DSH_LAN_GATEWAY__ = injected
  globalThis.fetch = () => {
    fetched = true
    return Promise.reject(new Error('must not be called'))
  }
  try {
    const result = await meta()
    return { result, fetched }
  } finally {
    globalThis.window = savedWindow
    globalThis.__DSH_LAN_GATEWAY__ = savedGlobal
    globalThis.fetch = savedFetch
  }
}

console.log('7) the injected global is preferred, and needs no network')
{
  // The desktop shell: this is the case that used to fail with "cannot read the
  // address", because a cross-origin fetch was blocked.
  const { result, fetched } = await resolveAt('dsh-app:', 'app', '', {
    port: 8791,
    lan: '10.61.18.139',
    appPath: '/__lan/app',
    appAvailable: true,
  })
  check('desktop shell resolves from the global', result.url === 'http://10.61.18.139:8791/__lan/app', JSON.stringify(result))
  check('no fetch was attempted', fetched === false)
}

console.log('8) the injected global also drives the not-built state')
{
  const { result, fetched } = await resolveAt('dsh-app:', 'app', '', {
    port: 8791,
    lan: '10.61.18.139',
    appAvailable: false,
  })
  check('reports not-built', result.available === false && result.reason === 'not-built', JSON.stringify(result))
  check('no fetch was attempted', fetched === false)
}

console.log('9) without the global, a phone still uses its own origin')
{
  const { result, fetched } = await resolveAt('http:', '10.61.18.139', '8791', undefined)
  check('phone origin wins', result.url === 'http://10.61.18.139:8791/__lan/app', JSON.stringify(result))
  check('no fetch was attempted', fetched === false)
}

console.log('10) a loopback page falls back to the status endpoint')
{
  const { fetched } = await resolveAt('http:', '127.0.0.1', '50215', undefined)
  check('fetch is used as the last resort', fetched === true)
}

console.log('11) the sidebar entry is absent inside the phone app')
{
  // The panel exists to get the app installed and paired. Inside the app it has
  // nothing to offer, so it must not register — a dead footer button is worse than
  // no button.
  check('an app check exists', source.includes('function insidePhoneApp'))
  check('it keys on the UA tag', /insidePhoneApp[\s\S]{0,200}DSHLanApp/.test(source))
  check('apply() skips registration in the app', /apply\(ctx\)\s*\{[\s\S]{0,1600}insidePhoneApp\(\)\)\s*return/.test(source))
  check('the slot entry is wrapped', source.includes('function LanGatewayEntry'))
  check('the wrapper bails before hooks', /function LanGatewayEntry[\s\S]{0,160}insidePhoneApp\(\)\)\s*return null/.test(source))
  check('the wrapper is what gets registered', source.includes('LanGatewayEntry,\n          ),'))
  // The wrapper must hold no hooks, or the early return would violate hook order.
  check('the wrapper has no hooks', !/function LanGatewayEntry[\s\S]{0,200}React\.use/.test(source))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
