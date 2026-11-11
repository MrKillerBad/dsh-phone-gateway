/**
 * The second authentication chain: gateway → DSH.
 *
 * The phone never receives the DSH launch token (rule 2 of the design). This
 * module keeps the token in process memory only, trades it for the browser
 * cookie once, caches that cookie, and re-trades when DSH restarts or the
 * cached cookie stops being accepted.
 *
 * The exchange is exactly what a desktop browser does on first open:
 *   GET <origin>/?token=<process token>  ->  303 + Set-Cookie + Location: ./
 *
 * The cookie name embeds `base64url(sha256(authority))`, so it is read back from
 * the response header instead of being hard-coded, and it is only valid for the
 * authority the rewritten `Host` header names.
 */

import { request as httpRequest } from 'node:http'

/** One loopback round trip; a slow first render of the SPA is still far under this. */
const EXCHANGE_TIMEOUT_MS = 10_000

/**
 * One loopback GET, resolved with status, headers, and body text.
 * `node:http` (not `fetch`) because the minted cookie depends on the exact Host
 * authority and the raw `Set-Cookie` line must stay readable.
 */
function loopbackGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        timeout: EXCHANGE_TIMEOUT_MS,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`no response within ${String(EXCHANGE_TIMEOUT_MS)} ms`))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Owner of the gateway's DSH credential.
 *
 * The cookie is cached as the literal `name=value` pair to replay, together
 * with the expiry the server stated, so a stale cookie is replaced before it is
 * ever sent. Concurrent callers share one in-flight exchange instead of racing
 * a burst of token trades.
 */
export class DshAuth {
  #ctx
  #cookie = null
  #expiresAt = 0
  #pending = null
  #lastError = null

  constructor(ctx) {
    this.#ctx = ctx
  }

  /** The cookie name as DSH minted it, for diagnostics only. */
  get cookieName() {
    return this.#cookie === null ? null : this.#cookie.slice(0, this.#cookie.indexOf('='))
  }

  /** Whether a usable cookie is cached right now. */
  get ready() {
    return this.#cookie !== null && Date.now() < this.#expiresAt
  }

  /** The last exchange failure, or null. */
  get lastError() {
    return this.#lastError
  }

  /** Drop the cached cookie; the next request trades for a fresh one. */
  invalidate() {
    this.#cookie = null
    this.#expiresAt = 0
  }

  /**
   * The cookie to replay, exchanging it first when absent, expired, or
   * explicitly invalidated.
   * @returns {Promise<string>} the `name=value` pair.
   */
  async cookie() {
    if (this.ready) return this.#cookie
    this.#pending ??= this.#exchange().finally(() => {
      this.#pending = null
    })
    return this.#pending
  }

  /**
   * Trade the process launch token for the browser cookie.
   *
   * `authenticatedUrl` is the only supported source of the token: it is minted
   * per process, so a DSH restart produces a new one and the next exchange
   * succeeds without the gateway restarting.
   */
  async #exchange() {
    const webServer = this.#ctx.webServer
    const port = webServer.port
    if (typeof port !== 'number' || port <= 0) {
      throw new Error('webServer.port is not assigned yet (the listener has not bound)')
    }
    const origin = webServer.getOrigin()
    const loginUrl = new URL(this.#ctx.connection.authenticatedUrl(origin))

    const minted = await loopbackGet(loginUrl, { accept: 'text/html' })
    const setCookie = [minted.headers['set-cookie'] ?? []].flat()
    const line = setCookie.find((entry) => entry.startsWith('dsh-auth-'))
    if (line === undefined) {
      throw new Error(`token exchange answered ${String(minted.status)} without a dsh-auth cookie`)
    }

    const pair = line.slice(0, line.indexOf(';'))
    this.#cookie = pair
    this.#expiresAt = expiryOf(line)
    this.#lastError = null
    return pair
  }

  /**
   * Prove the cached cookie still authenticates by replaying it on `/`.
   * Used by the status probe; a failed replay invalidates the cache so the next
   * real request trades again rather than serving a broken page.
   * @returns {Promise<number>} the status code the replay received.
   */
  async verify() {
    const pair = await this.cookie()
    const origin = this.#ctx.webServer.getOrigin()
    const response = await loopbackGet(new URL(`${origin}/`), { cookie: pair, accept: 'text/html' })
    if (response.status !== 200) this.invalidate()
    return response.status
  }
}

/**
 * Absolute expiry from a `Set-Cookie` line's `Max-Age`, falling back to its
 * `Expires`, and finally to a conservative short life when neither parses: a
 * missing expiry must not make the gateway keep a cookie forever.
 */
function expiryOf(setCookieLine) {
  const now = Date.now()
  const maxAge = /;\s*Max-Age=(\d+)/i.exec(setCookieLine)
  if (maxAge !== null) return now + Number(maxAge[1]) * 1000
  const expires = /;\s*Expires=([^;]+)/i.exec(setCookieLine)
  if (expires !== null) {
    const at = Date.parse(expires[1])
    if (Number.isFinite(at)) return at
  }
  return now + 60_000
}
