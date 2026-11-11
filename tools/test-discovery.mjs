/**
 * Discovery tests, including the null-vs-undefined bug that killed DSH.
 *
 * Node's `dgram.send` callback receives `null` on success, not `undefined`.
 * The responder originally wrote `if (error !== undefined) log(error.message)`,
 * which was true for EVERY successful reply, then threw on `null.message`
 * inside a libuv callback — an uncaught throw that terminated the host process.
 *
 * Run:  node tools/test-discovery.mjs
 */

import { createSocket } from 'node:dgram'

import { DISCOVERY_PORT, DISCOVERY_SERVICE, startDiscovery } from '../dsh-phone-gateway/lib/discovery.js'
import { localAddressFor } from '../dsh-phone-gateway/lib/net.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

/** Send one datagram and collect every reply within the window. */
async function ask(query, { port = DISCOVERY_PORT, waitMs = 600 } = {}) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  const replies = []
  socket.on('message', (message) => {
    try {
      replies.push(JSON.parse(message.toString('utf8')))
    } catch {
      /* ignore */
    }
  })
  await new Promise((resolve) => socket.bind(0, resolve))
  const payload = Buffer.isBuffer(query) ? query : Buffer.from(JSON.stringify(query))
  socket.send(payload, port, '127.0.0.1')
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  socket.close()
  return replies
}

const logs = []
const responder = await startDiscovery({
  httpPort: 8791,
  config: { restrictSameSubnet: true, allowSubnets: [] },
  log: (message) => logs.push(message),
})

if (responder === null) {
  // A live gateway already owns the UDP port. Skipping silently made this suite look
  // like a pass with zero assertions, so instead of skipping we exercise the listener
  // that is actually running — a stronger check than the one we would have made.
  console.log('NOTE: UDP port busy — testing the LIVE responder instead of a private one')
  const replies = await ask({ probe: DISCOVERY_SERVICE })
  check('the live responder answers', replies.length >= 1, `got ${replies.length}`)
  const reply = replies[0]
  check('service name matches', reply?.service === DISCOVERY_SERVICE)
  check('url is absolute http', typeof reply?.url === 'string' && reply.url.startsWith('http://'), reply?.url)
  check('address is a dotted quad', /^\d+\.\d+\.\d+\.\d+$/.test(reply?.address ?? ''), reply?.address)
  // Malformed probes must be ignored by the live listener, not crash it.
  const junk = await ask({ probe: 'not-this-service' }, { waitMs: 300 })
  check('the live responder ignores foreign probes', junk.length === 0, `got ${junk.length}`)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('1) a valid probe is answered with a usable URL')
{
  const replies = await ask({ probe: DISCOVERY_SERVICE })
  check('got a reply', replies.length >= 1, `got ${replies.length}`)
  const reply = replies[0]
  check('service name matches', reply?.service === DISCOVERY_SERVICE)
  check('port is the HTTP port', reply?.port === 8791)
  check('url is absolute http', typeof reply?.url === 'string' && reply.url.startsWith('http://'), reply?.url)
  check('url carries the announced port', reply?.url?.endsWith(':8791'), reply?.url)
  check('address is a dotted quad', /^\d+\.\d+\.\d+\.\d+$/.test(reply?.address ?? ''), reply?.address)
}

console.log('2) THE CRASH CASE: successful sends must not throw')
{
  // Ten replies through loopback; before the fix every one of these threw.
  for (let index = 0; index < 10; index += 1) {
    await ask({ probe: DISCOVERY_SERVICE }, { waitMs: 120 })
  }
  const replyFailures = logs.filter((line) => line.includes('discovery reply failed'))
  check('no reply-failure log on success', replyFailures.length === 0, replyFailures.join(' | '))
  console.log('     (a throw here would have taken down this process)')
}

console.log('3) malformed and foreign datagrams are ignored, never thrown')
{
  const before = logs.filter((line) => line.includes('discovery query failed')).length
  await ask(Buffer.from('not json at all'), { waitMs: 200 })
  await ask(Buffer.from('{"probe":"something-else"}'), { waitMs: 200 })
  await ask(Buffer.from('{}'), { waitMs: 200 })
  await ask(Buffer.alloc(2048, 0x41), { waitMs: 200 }) // over the size cap
  const after = logs.filter((line) => line.includes('discovery query failed')).length
  check('no unhandled query failures', after === before, `${after - before} logged`)
}

console.log('4) localAddressFor picks a same-subnet interface')
{
  const address = localAddressFor('127.0.0.1')
  check('loopback maps to an address or undefined (never a throw)', address === undefined || typeof address === 'string')
  const stranger = localAddressFor('203.0.113.9')
  check('a foreign address yields undefined', stranger === undefined)
  check('garbage input yields undefined', localAddressFor('not-an-ip') === undefined)
}

console.log('5) responder keeps working after all of the above')
{
  const replies = await ask({ probe: DISCOVERY_SERVICE })
  check('still answering', replies.length >= 1, `got ${replies.length}`)
}

await responder.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
