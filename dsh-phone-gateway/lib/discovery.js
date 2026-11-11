/**
 * LAN discovery: how the phone app finds this computer without an address.
 *
 * The problem this solves is NOT "typing a URL is annoying" — it is that the
 * address CHANGES. A QR code encodes one address at one moment; the next time
 * the phone joins a different hotspot, that code is useless and the operator
 * would have to walk back to the computer. A 6-digit pairing code has the same
 * flaw: it proves identity, it does not carry a location.
 *
 * So the phone asks the network instead:
 *
 *   phone  ──broadcast──▶ 255.255.255.255:8792  {"probe":"dsh-phone-gateway"}
 *   gateway ──unicast──▶  the phone's socket     {"service":..., "url":"http://10.x.y.z:8791"}
 *
 * The answer carries whatever address is current RIGHT NOW, resolved from the
 * interface that shares the querier's subnet. Rejoin a different network and
 * the next broadcast simply gets a different answer — no re-pairing, no rescan,
 * no address to remember.
 *
 * Deliberate limits:
 *  - Only peers the gateway would serve anyway get an answer (`isAllowedPeer`),
 *    so discovery never widens exposure: it announces a port that is already
 *    open to exactly those peers.
 *  - The reply says nothing about pairing state, devices, or the DSH port. It is
 *    a location hint; authentication stays where it was.
 *  - Discovery is read-only state: no device is created, no code is consumed, so
 *    a broadcast storm cannot disturb the pairing store.
 */

import { createSocket } from 'node:dgram'

import { isAllowedPeer, listInterfaces, localAddressFor } from './net.js'

/** The discovery port. Distinct from the HTTP port by design. */
export const DISCOVERY_PORT = 8792

/** Identifies this service in replies; the app matches on it. */
export const DISCOVERY_SERVICE = 'dsh-phone-gateway'

/** Largest query the gateway will look at; anything bigger is not ours. */
const MAX_QUERY_BYTES = 512

/** The first non-loopback IPv4 address, used when the querier is loopback. */
function firstLanAddress() {
  const entry = listInterfaces().find((candidate) => candidate.family === 'IPv4')
  return entry?.address
}

/**
 * Start the discovery responder.
 *
 * Binding `0.0.0.0` is required: a broadcast arrives on whichever interface the
 * phone's network uses, and the kernel picks that interface only for a wildcard
 * bind.
 *
 * @param {object} options
 * @param {number} options.httpPort - the gateway's HTTP port, announced to clients.
 * @param {object} options.config - resolved gateway configuration (subnet gate).
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @returns {Promise<{close: () => Promise<void>} | null>} the responder, or null
 * when the port is unavailable (discovery is an optimisation, never a boot blocker).
 */
export async function startDiscovery({ httpPort, config, log }) {
  // Deliberately WITHOUT `reuseAddr`: two sockets sharing one UDP port split
  // incoming datagrams between them non-deterministically, so a second copy of
  // this responder (an old plugin generation, a stale process) would silently
  // steal every query. A plain bind makes that collision an explicit EADDRINUSE
  // that the caller can see and report.
  const socket = createSocket({ type: 'udp4' })

  socket.on('error', (error) => {
    // An error handler that itself throws is how this file took DSH down once.
    log?.(`lan-gateway: discovery socket error: ${String(error?.message ?? error)}`)
  })

  socket.on('message', (message, remote) => {
    // A datagram handler runs on libuv's callback; an uncaught throw here
    // escapes to the process and kills DSH. Everything below is defensive for
    // that reason alone.
    try {
      handleMessage(message, remote)
    } catch (error) {
      log?.(`lan-gateway: discovery query failed: ${String(error?.message ?? error)}`)
    }
  })

  function handleMessage(message, remote) {
    if (message.byteLength > MAX_QUERY_BYTES) return

    let query
    try {
      query = JSON.parse(message.toString('utf8'))
    } catch {
      return
    }
    if (query?.probe !== DISCOVERY_SERVICE) return

    // Announce only to peers the HTTP listener would serve. This keeps
    // discovery from being a way to find a machine that would refuse you.
    if (!isAllowedPeer(remote.address, config)) return

    // Answer with the local address that shares the querier's subnet, so a
    // multi-homed machine (WiFi + hotspot + VPN) names the reachable one.
    //
    // A loopback querier (the operator testing on the machine itself) shares no
    // subnet with any LAN interface, so it falls back to the first LAN address:
    // the phone the app runs on is never loopback, and refusing to answer a
    // local probe would make the service look broken during testing.
    const address = localAddressFor(remote.address) ?? firstLanAddress()
    if (address === undefined) return

    const reply = Buffer.from(
      JSON.stringify({
        service: DISCOVERY_SERVICE,
        url: `http://${address}:${String(httpPort)}`,
        // Reported separately so a client can show it before connecting.
        port: httpPort,
        address,
      }),
      'utf8',
    )
    socket.send(reply, remote.port, remote.address, (error) => {
      // node's dgram callback passes `null` on success, not `undefined`;
      // `error !== undefined` was true for every successful send.
      if (error !== null && error !== undefined) {
        log?.(`lan-gateway: discovery reply failed: ${String(error?.message ?? error)}`)
      }
    })
  }

  const bound = await new Promise((resolve) => {
    const onFailure = (error) => {
      log?.(`lan-gateway: discovery unavailable on UDP ${String(DISCOVERY_PORT)}: ${String(error?.message ?? error)}`)
      resolve(false)
    }
    socket.once('error', onFailure)
    socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      socket.off('error', onFailure)
      resolve(true)
    })
  })

  if (!bound) {
    try {
      socket.close()
    } catch {
      /* already closed */
    }
    return null
  }

  log?.(`lan-gateway: discovery listening on UDP ${String(DISCOVERY_PORT)}`)

  return {
    close: () =>
      new Promise((resolve) => {
        try {
          socket.close(() => {
            resolve()
          })
        } catch {
          resolve()
        }
      }),
  }
}
