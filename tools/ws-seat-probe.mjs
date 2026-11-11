/**
 * Two paired devices, one real WebSocket each: does the primary evict the secondary?
 *
 * Reproduces the operator's report end to end — pairing, role assignment, a genuine
 * `/api/remote.mux` upgrade for both phones, then plain HTTP as each.
 *
 * Operator routes (pairing code, device list) answer on LOOPBACK only, while the seat
 * rules only apply to a request that does NOT come from this computer — so the two
 * bases differ on purpose.
 *
 * Run:  node tools/ws-seat-probe.mjs http://<lan-ip>:8791
 */

import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'

const LAN = new URL(process.argv[2] ?? 'http://10.61.18.139:8791')
const OPERATOR = 'http://127.0.0.1:' + LAN.port

let failures = 0
const check = (name, ok, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + (ok ? '' : ' ' + (detail ?? '')))
  if (!ok) failures += 1
}

async function pair(label) {
  const codeRes = await fetch(OPERATOR + '/__lan/code', { method: 'POST' })
  const code = (await codeRes.json()).code
  const res = await fetch(OPERATOR + '/__lan/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error('pair failed: ' + JSON.stringify(body))
  const cookie = res.headers.getSetCookie()[0].split(';')[0]
  return { id: body.deviceId, cookie }
}

const setPrimary = (deviceId) =>
  fetch(OPERATOR + '/__lan/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setPrimary: deviceId }),
  })

const revoke = (deviceId) =>
  fetch(OPERATOR + '/__lan/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revoke: deviceId }),
  })

/** Page status as seen from the LAN (a real device, not this computer). */
async function pageStatus(cookie) {
  const res = await fetch(LAN.origin + '/', {
    headers: { cookie, accept: 'text/html,application/xhtml+xml' },
    redirect: 'manual',
  })
  return { status: res.status, location: res.headers.get('location') }
}

/** Open one raw upgrade; resolves with the status line and the live socket. */
function openMux(cookie) {
  return new Promise((resolve, reject) => {
    const key = createHash('sha1').update(String(Date.now() + Math.random())).digest('base64')
    const socket = createConnection({ host: LAN.hostname, port: Number(LAN.port) }, () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n'
          + 'Host: ' + LAN.host + '\r\n'
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Origin: ' + LAN.origin + '\r\n'
          + 'Sec-WebSocket-Extensions: permessage-deflate\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Key: ' + key + '\r\n'
          + 'Cookie: ' + cookie + '\r\n\r\n',
      )
    })
    let head = ''
    const onData = (chunk) => {
      head += chunk.toString('latin1')
      const at = head.indexOf('\r\n')
      if (at === -1) return
      socket.off('data', onData)
      resolve({ line: head.slice(0, at), socket })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.setTimeout(6000, () => reject(new Error('timeout')))
  })
}

const settle = (socket) =>
  new Promise((resolve) => {
    if (socket.destroyed) return resolve('already')
    socket.on('close', () => resolve('closed'))
    setTimeout(() => resolve('open'), 2500)
  })

// The probe must leave the operator's configuration exactly as it found it: it used
// to revoke its own devices and take the real primary down with them.
const previousPrimary = (await (await fetch(OPERATOR + '/__lan/status')).json()).devices.primary

const a = await pair('probe-primary')
const b = await pair('probe-secondary')
await setPrimary(a.id)
console.log('  A(主控)   = ' + a.id)
console.log('  B(从设备) = ' + b.id + '\n')

console.log('1) B 先连上（抢占空席位）')
const bMux = await openMux(b.cookie)
// DSH owns the handshake and rejects a synthetic one with 400; what matters here is
// that OUR gateway did not refuse it (403 is our refusal).
check('B 的 WebSocket 未被网关拒绝', !bMux.line.includes('403'), bMux.line)
check('B 此时能取到页面', (await pageStatus(b.cookie)).status === 200)

console.log('\n2) A（主控）连上 —— 应当踢掉 B')
const aMux = await openMux(a.cookie)
check('A 的 WebSocket 未被网关拒绝', !aMux.line.includes('403'), aMux.line)
check('A 能取到页面', (await pageStatus(a.cookie)).status === 200)

console.log('\n3) B 应当被踢')
await settle(bMux.socket)  // informational: DSH never completed the handshake here
const bPage = await pageStatus(b.cookie)
check('B 的页面请求被重定向到占用页', bPage.status === 302 && String(bPage.location).startsWith('/__lan/busy'), JSON.stringify(bPage))
const seat = await (await fetch(LAN.origin + '/__lan/seat', { headers: { cookie: b.cookie } })).json()
check('B 的席位查询报 busy', seat.busy === true, JSON.stringify(seat))

console.log('\n4) A 仍然正常')
check('A 的页面请求成功', (await pageStatus(a.cookie)).status === 200)

for (const device of [a, b]) await revoke(device.id)
// Put the operator's primary back, whatever it was before the probe ran.
if (previousPrimary) await setPrimary(previousPrimary)
try {
  aMux.socket.destroy()
  bMux.socket.destroy()
} catch {
  // already gone
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exitCode = failures === 0 ? 0 : 1
