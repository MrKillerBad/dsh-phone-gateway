/**
 * The one-seat rule.
 *
 * Both the HTTP path and the WebSocket path consult this table, so it is the single
 * place where "who may use DSH right now" is decided. The operator's rule is narrow
 * on purpose: **only the primary kicks**, a secondary never displaces anyone — not
 * even another secondary — and it is told another device is in use.
 *
 * Run:  node tools/test-slot.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { busyPayload, decideSlot } from '../dsh-phone-gateway/lib/slot.js'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) the seat is free: whoever asks takes it')
{
  check('the primary takes a free seat', decideSlot({ holder: null, deviceId: 'A', primaryId: 'A' }) === 'take')
  check('a secondary takes a free seat', decideSlot({ holder: null, deviceId: 'C', primaryId: 'A' }) === 'take')
  check('the holder keeps its seat', decideSlot({ holder: 'A', deviceId: 'A', primaryId: 'A' }) === 'allow')
}

console.log('2) only the primary kicks')
{
  check('the primary displaces a secondary', decideSlot({ holder: 'B', deviceId: 'A', primaryId: 'A' }) === 'take')
  // The rule the operator asked for: a secondary waits, it does not fight.
  check('a secondary cannot displace the primary', decideSlot({ holder: 'A', deviceId: 'B', primaryId: 'A' }) === 'busy')
  check('a secondary cannot displace another secondary', decideSlot({ holder: 'B', deviceId: 'C', primaryId: 'A' }) === 'busy')
}

console.log('3) degenerate input never grants the seat')
{
  check('an empty device id is refused', decideSlot({ holder: null, deviceId: '', primaryId: 'A' }) === 'busy')
  check('a missing device id is refused', decideSlot({ holder: null, deviceId: undefined, primaryId: 'A' }) === 'busy')
  // No designated primary (or a revoked one): the seat must stay reachable, or a
  // revoked primary would lock every phone out permanently.
  check('without a primary the seat is first-come', decideSlot({ holder: 'A', deviceId: 'B', primaryId: null }) === 'take')
  check('without a primary a free seat is still usable', decideSlot({ holder: null, deviceId: 'B', primaryId: null }) === 'take')
  check('a stale holder does not block (handler clears it)', /const currentHolder[\s\S]{0,400}activeSession = null/.test(readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')))
}

console.log('4) the refusal tells the client how long to wait')
{
  const payload = busyPayload()
  check('it names the condition', payload.error === 'device-busy', String(payload.error))
  check('it asks for a bounded retry', Number.isInteger(payload.retryAfterMs) && payload.retryAfterMs > 0)
}

console.log('5) both request paths use this table')
{
  const gateway = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
  // The HTTP path — a kicked device must stop working, not merely stop streaming.
  check('the HTTP path decides', /const verdict = decideSlot\(\{[\s\S]{0,300}primaryId: devices\.primaryId/.test(gateway))
  check('it answers /api with JSON', /pathname\.startsWith\('\/api\/'\)[\s\S]{0,300}busyPayload\(\)/.test(gateway))
  check('it redirects navigations to the busy page', /refuseBusy[\s\S]{0,700}302[\s\S]{0,200}BUSY_PATH/.test(gateway))
  check('subresources are refused, not redirected', /writeHtml\(res, 403, busyPage/.test(gateway))
  check('the upgrade path decides too', /handleUpgrade[\s\S]{0,2000}decideSlot\(/.test(gateway))
  check('a busy upgrade is refused', /verdict === 'busy'[\s\S]{0,300}refuse\(socket\)/.test(gateway))
  check('taking the seat kicks the previous holder', /const claimSeat[\s\S]{0,900}previous\.socket\?\.destroy\(\)/.test(gateway))
  check('a closed holder frees the seat', /socket\.on\('close'[\s\S]{0,300}activeSession = null/.test(gateway))
  // Loopback is the computer itself and must never be locked out by a phone. Both
  // paths gate on it before consulting the table (the HTTP path via its own
  // `loopback` variable).
  check('the HTTP path never seats loopback', /if \(!loopback\) \{[\s\S]{0,1600}decideSlot/.test(gateway))
  check('the upgrade path never seats loopback', /if \(!isLoopback\(peer\)\) \{[\s\S]{0,1200}decideSlot/.test(gateway))
}

console.log('6) the phone is told in words, not a bare status code')
{
  const page = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'pair-page.js'), 'utf8')
  check('a busy page exists', page.includes('export function busyPage'))
  check('it says another device is in use', page.includes('设备正在使用中'))
  check('it explains the rule', page.includes('只有一台设备能同时使用'))
  check('it retries by itself', /location\.reload\(\)/.test(page))
  check('it offers a manual retry', page.includes('立即重试'))
}

console.log('7) an evicted page is told at once, not on its next click')
{
  const gateway = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
  const client = readFileSync(join(here, '..', 'dsh-phone-gateway', 'client.js'), 'utf8')
  const proxy = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'proxy.js'), 'utf8')

  // A long poll that the host wakes: killing the WebSocket alone left the page
  // showing everything it had already rendered.
  check('a seat route exists', gateway.includes('SEAT_PATH'))
  check('it supports a held query', /wait.*'1'|searchParams\.get\('wait'\)/.test(gateway))
  check('waiters are woken on a change', /const notifySeat = \(\) => \{[\s\S]{0,200}seatWaiters/.test(gateway))
  check('claiming the seat wakes them', /const claimSeat[\s\S]{0,1200}notifySeat\(\)/.test(gateway))
  check('they are released on disconnect', /res\.on\('close'[\s\S]{0,200}seatWaiters\.delete/.test(gateway))

  // The kicked page must leave entirely, so nothing it had loaded stays visible.
  check('the page watches the seat', client.includes('startSeatWatcher'))
  check('it navigates away, not merely overlays', /location\.assign\('\/'\)/.test(client))
  check('it only watches on LAN origins', /const loopback[\s\S]{0,300}if \(loopback\) return/.test(client))
  check('the watcher starts even inside the app', /installWorkspacePickerBridge\(\)[\s\S]{0,300}startSeatWatcher\(\)/.test(client))

  // The seat route cannot see the device cookie — the proxy replaces it — so the
  // gateway carries the id in a header it sets itself after verifying.
  check('the proxy forwards the device id', /x-dsh-phone-gateway-device/.test(proxy))
  check('a client-supplied value is dropped first', /delete headers\['x-dsh-phone-gateway-device'\]/.test(proxy))
  check('the route reads that header', /req\.headers\['x-dsh-phone-gateway-device'\]/.test(gateway))
  check('it validates the id against the store', /devices\.list\(\)\.some/.test(gateway))

  // A query must not claim the seat, or the kicked phone's own poll would fight
  // the primary for it.
  check('helper routes never claim', /isHelperPath[\s\S]{0,200}verdict === 'take' && !isHelperPath/.test(gateway))
  check('the seat route stays reachable while busy', /pathname === SEAT_PATH[\s\S]{0,300}fall through/.test(gateway))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
