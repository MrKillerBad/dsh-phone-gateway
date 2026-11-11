/**
 * Protocol conformance between the Android app and the gateway.
 *
 * The APK cannot be run here (no device attached), so the one thing that CAN be
 * proven is that both halves agree on the wire format. This replays the exact
 * bytes Discovery.java sends and checks the answer against what it parses.
 *
 * Java side (Discovery.java):
 *   sends  {"probe":"dsh-phone-gateway"}
 *   reads  reply.service == "dsh-phone-gateway"
 *          reply.url     startsWith "http://"
 *
 * Run:  node tools/test-discovery-contract.mjs
 */

import { createSocket } from 'node:dgram'

import { startDiscovery } from '../dsh-phone-gateway/lib/discovery.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

const responder = await startDiscovery({
  httpPort: 8791,
  config: { restrictSameSubnet: true, allowSubnets: [] },
  log: () => undefined,
})

if (responder === null) {
  // A live gateway owns the port, so the private responder cannot bind. Rather than
  // skip — which made this suite look like a pass with no assertions — check the
  // listener that is actually running against the same contract.
  console.log('NOTE: UDP 8792 busy — checking the LIVE responder against the contract')
  const probe = await ask('{"probe":"dsh-phone-gateway"}')
  check('the live responder answers the app query', probe.length >= 1, `got ${probe.length}`)
  const live = probe[0]
  check('service field matches SERVICE constant', live?.service === 'dsh-phone-gateway', String(live?.service))
  check('url starts with http:// (app requirement)', String(live?.url).startsWith('http://'), String(live?.url))
  check('url parses as a URL the WebView can load', (() => {
    try {
      new URL(String(live?.url))
      return true
    } catch {
      return false
    }
  })())
  check('reply fits a 1024-byte buffer (app reads 1024)', JSON.stringify(live).length < 1024)
  const foreign = await ask('{"probe":"something-else"}')
  check('a foreign probe is ignored', foreign.length === 0, `got ${foreign.length}`)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

/** The literal query string Discovery.java builds. */
const JAVA_QUERY = '{"probe":"dsh-phone-gateway"}'

function ask(raw, { broadcast = false } = {}) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const replies = []
    socket.on('message', (message) => {
      replies.push(JSON.parse(message.toString('utf8')))
    })
    socket.bind(0, () => {
      if (broadcast) socket.setBroadcast(true)
      const payload = Buffer.from(raw, 'utf8')
      socket.send(payload, 8792, '127.0.0.1', () => {
        setTimeout(() => {
          socket.close()
          resolve(replies)
        }, 400)
      })
    })
  })
}

console.log('1) the exact query the app sends is understood')
{
  const replies = await ask(JAVA_QUERY)
  check('answered', replies.length >= 1, `got ${replies.length}`)
  const reply = replies[0] ?? {}

  // Field-by-field, mirroring Discovery.java's parser.
  check('service field matches SERVICE constant', reply.service === 'dsh-phone-gateway', String(reply.service))
  check('url field present', typeof reply.url === 'string', String(reply.url))
  check('url starts with http:// (app requirement)', String(reply.url).startsWith('http://'), String(reply.url))
  check('url parses as a URL the WebView can load', (() => {
    try {
      const parsed = new URL(reply.url)
      return parsed.protocol === 'http:' && parsed.port === '8791' && parsed.hostname !== ''
    } catch {
      return false
    }
  })(), String(reply.url))
}

console.log('2) a reply is valid JSON inside one datagram')
{
  const replies = await ask(JAVA_QUERY)
  check('reply fits a 1024-byte buffer (app reads 1024)', JSON.stringify(replies[0] ?? {}).length < 1024)
}

console.log('3) a query WITHOUT the probe tag is ignored (no accidental answers)')
{
  const replies = await ask('{"probe":"something-else"}')
  check('no reply', replies.length === 0, `got ${replies.length}`)
}

console.log('4) whitespace/key-order variants still parse')
{
  const replies = await ask('{ "probe" : "dsh-phone-gateway" }')
  check('tolerates spacing', replies.length >= 1, `got ${replies.length}`)
}

await responder.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
