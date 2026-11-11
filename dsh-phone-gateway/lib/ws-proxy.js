/**
 * WebSocket upgrade forwarding: phone ⇄ gateway ⇄ DSH.
 *
 * DSH answers exactly one upgrade path (`/api/remote.mux`, the Remote stream
 * mux) and admission checks the same Host/Origin fence plus the browser cookie
 * as `/api`. So the same two rewrites that make HTTP work make WebSocket work:
 * `Host`/`Origin` become the loopback authority, and the cached DSH cookie is
 * injected on the way out.
 *
 * Everything else must pass through **byte for byte**. The handshake
 * (`Sec-WebSocket-Key` → `Sec-WebSocket-Accept`) and the negotiated
 * `permessage-deflate` extension are end-to-end between the phone and DSH; a
 * proxy that re-implemented the handshake would have to re-implement
 * compression too. Hence a raw TCP pipe rather than a WebSocket client.
 *
 * The design's heartbeat rule is kept: no read or write timeout is set on
 * either socket, so DSH's own ping keeps the connection alive and an idle
 * session is never cut by the gateway.
 */

import { connect } from 'node:net'

/** HTTP status and body for an upgrade the gateway refuses itself. */
const REFUSAL = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

/**
 * Serialize the upgrade request for the loopback listener.
 *
 * `rawHeaders` is used instead of `headers` so header order, case and repeats
 * survive: a handshake is compared byte-wise by some peers. Values are written
 * as latin1, the encoding Node decoded them from, so no byte is re-encoded.
 *
 * @param {import('node:http').IncomingMessage} req - the phone's upgrade request.
 * @param {string} origin - the loopback origin, e.g. `http://127.0.0.1:50215`.
 * @param {string} cookie - the DSH `name=value` pair to inject.
 * @returns {Buffer} the complete request head.
 */
export function upgradeHead(req, origin, cookie) {
  const target = new URL(origin)
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
  const raw = req.rawHeaders ?? []
  let hostWritten = false

  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    const lower = String(name).toLowerCase()
    if (lower === 'host') {
      // One Host header, and it is the authority the cookie is bound to.
      if (hostWritten) continue
      hostWritten = true
      lines.push(`Host: ${target.host}`)
      continue
    }
    if (lower === 'origin') {
      // Must match Host, or DSH's isSameAuthorityOrigin check fails.
      lines.push(`Origin: ${target.origin}`)
      continue
    }
    if (lower === 'cookie') continue
    lines.push(`${name}: ${value}`)
  }

  if (!hostWritten) lines.push(`Host: ${target.host}`)
  lines.push(`Cookie: ${cookie}`)
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')
}

/** Refuse an upgrade the gateway itself rejects, without touching DSH. */
function refuse(socket) {
  try {
    socket.end(REFUSAL)
  } catch {
    socket.destroy()
  }
}

/**
 * Forward one upgrade to DSH and pipe both directions until either side closes.
 *
 * @param {import('node:http').IncomingMessage} req - the phone's upgrade request.
 * @param {import('node:net').Socket} socket - the phone's raw socket.
 * @param {Buffer} head - bytes already read past the request head.
 * @param {{origin: string, cookie: string}} context - loopback target and credential.
 */
export function proxyUpgrade(req, socket, head, context) {
  const target = new URL(context.origin)

  const upstream = connect({
    host: target.hostname,
    port: Number(target.port),
  })

  // DSH's heartbeat owns liveness on both legs (design: no gateway timeouts).
  socket.setTimeout(0)
  socket.setNoDelay(true)
  upstream.setTimeout(0)
  upstream.setNoDelay(true)

  const shutdown = () => {
    socket.destroy()
    upstream.destroy()
  }

  upstream.on('connect', () => {
    upstream.write(upgradeHead(req, context.origin, context.cookie))
    // Bytes the parser already consumed beyond the head belong to DSH.
    if (head !== undefined && head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })

  // Either side failing tears down both: a half-open mux would keep a session
  // alive on DSH while the phone believes it is disconnected.
  upstream.on('error', shutdown)
  socket.on('error', shutdown)
  upstream.on('close', shutdown)
  socket.on('close', shutdown)
}

/** Exported for the listener's own subnet gate, which answers before connecting. */
export { refuse }
