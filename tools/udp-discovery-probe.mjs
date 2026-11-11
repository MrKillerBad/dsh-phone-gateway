/**
 * Can the gateway be found automatically on the LAN?
 *
 * The user's real complaint is not "typing a URL is tedious" — it is that the
 * address CHANGES when the network changes. A QR code carries one address at
 * one moment; it cannot survive a new network.
 *
 * This probe tests the mechanism that can: UDP broadcast discovery.
 *
 *   phone  --broadcast "who is the gateway?"-->  255.255.255.255:8792
 *   gateway --unicast  {url: "http://10.x.y.z:8791"}--> phone's socket
 *
 * If this works, the app needs no address at all: it asks the network and the
 * gateway answers with whatever address is current right now.
 *
 * Run:  node tools/udp-discovery-probe.mjs
 */

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

const PORT = 8792
const QUERY = Buffer.from(JSON.stringify({ probe: 'dsh-phone-gateway' }))

/** Every IPv4 broadcast address this machine can see. */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      const broadcast = ip.map((octet, index) => (octet | (~mask[index] & 0xff)) >>> 0)
      targets.add(broadcast.join('.'))
    }
  }
  return [...targets]
}

// ---- the "gateway" side: answer every query with the live address ---------
const gateway = createSocket({ type: 'udp4', reuseAddr: true })
gateway.on('error', (error) => {
  console.error('gateway socket error:', error.message)
  process.exitCode = 1
})
gateway.on('message', (message, remote) => {
  let parsed
  try {
    parsed = JSON.parse(message.toString('utf8'))
  } catch {
    return
  }
  if (parsed?.probe !== 'dsh-phone-gateway') return
  const answer = Buffer.from(
    JSON.stringify({
      service: 'dsh-phone-gateway',
      port: 8791,
      interfaces: Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address),
    }),
  )
  console.log(`gateway: answering ${remote.address}:${remote.port}`)
  gateway.send(answer, remote.port, remote.address)
})

await new Promise((resolve, reject) => {
  gateway.once('listening', resolve)
  gateway.once('error', reject)
  gateway.bind(PORT)
})
console.log(`gateway: listening on 0.0.0.0:${PORT}/udp`)

// ---- the "phone" side: broadcast, then wait for an answer -----------------
const phone = createSocket({ type: 'udp4', reuseAddr: true })
await new Promise((resolve, reject) => {
  phone.once('listening', resolve)
  phone.once('error', reject)
  phone.bind(0)
})
phone.setBroadcast(true)

const replies = []
phone.on('message', (message, remote) => {
  try {
    const parsed = JSON.parse(message.toString('utf8'))
    if (parsed?.service !== 'dsh-phone-gateway') return
    replies.push({ from: `${remote.address}:${remote.port}`, ...parsed })
  } catch {
    /* ignore non-JSON */
  }
})

const targets = broadcastTargets()
console.log(`phone: broadcasting to ${targets.join(', ')}`)
for (const target of targets) {
  phone.send(QUERY, PORT, target, (error) => {
    if (error) console.log(`  send to ${target} failed: ${error.message}`)
  })
}

await new Promise((resolve) => setTimeout(resolve, 1200))

phone.close()
gateway.close()

console.log('')
console.log(JSON.stringify({ broadcastTargets: targets, replies }, null, 2))
console.log('')
console.log(replies.length > 0 ? 'RESULT: discovery WORKS on this machine' : 'RESULT: no reply (broadcast may be blocked)')
process.exitCode = replies.length > 0 ? 0 : 1
