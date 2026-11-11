/**
 * The HTTP reverse proxy: phone → gateway (8791) → DSH (127.0.0.1:<port>).
 *
 * Two independent authentication chains meet here, and the proxy is the seam:
 *
 *   phone → gateway   the operator's own machine today (loopback is always
 *                     allowed), the paired device cookie from step 4 later.
 *   gateway → DSH     the cached browser cookie from `DshAuth`.
 *
 * What the proxy owns, per request:
 *
 *  - `Host` and `Origin` rewritten to the loopback authority. DSH's `/api`
 *    fence accepts loopback, and the auth cookie is bound to that authority,
 *    so rewriting satisfies both the fence and the cookie check at once.
 *  - The DSH cookie injected on the way out.
 *  - Every `Set-Cookie` stripped on the way back: the phone must never hold a
 *    DSH credential (rule 2). The gateway will sign its own device cookie in
 *    step 4.
 *  - `index.html` rewritten so a phone lays the desktop UI out at 1024 CSS px.
 *    Navigation requests drop `gzip` from `accept-encoding`, because the body
 *    is rewritten and DSH compresses anything over 1024 bytes.
 *  - `content-length` recomputed from the rewritten bytes, or dropped when the
 *    upstream used a different framing.
 *
 * Hop-by-hop headers are never forwarded in either direction.
 */

import { request as httpRequest } from 'node:http'

/** Headers that describe one hop only; forwarding them corrupts the next one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** The viewport the phone should lay this desktop-only UI out at. */
const MOBILE_VIEWPORT = '<meta name="viewport" content="width=1024" />'

/**
 * Rewrite the served index for a phone: one viewport tag, desktop width.
 *
 * The shipped page carries `width=device-width, initial-scale=1`; there are no
 * responsive breakpoints anywhere in the frontend (aside from the sidebar's
 * narrow-mode media query), so scaling the whole layout is the intended
 * strategy rather than reflowing it.
 *
 * A page that reaches the phone with the DEVICE-width viewport instead renders the
 * desktop layout at phone width — everything several times too large. So the match
 * tolerates either attribute order, and a document with no tag at all gets one
 * inserted rather than passing through unrewritten.
 */
export function injectViewport(html) {
  const existing = /<meta\s+[^>]*name=["']viewport["'][^>]*>/i
  if (existing.test(html)) return html.replace(existing, MOBILE_VIEWPORT)
  // No tag: put one in the head, or the page falls back to the phone's own width.
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${MOBILE_VIEWPORT}`)
  }
  return `${MOBILE_VIEWPORT}\n${html}`
}

/** Whether this request is a navigation for a document (the one to rewrite). */
function wantsDocument(req) {
  const dest = req.headers['sec-fetch-dest']
  if (dest === 'document') return true
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/** Whether the upstream response is the SPA document. */
function isDocumentResponse(res) {
  const type = res.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('text/html')
}

/** Drop `gzip` from an accept-encoding value so the upstream answers in clear text. */
function withoutGzip(value) {
  if (typeof value !== 'string') return 'identity'
  const kept = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^gzip\b/i.test(part) && !/^\*\s*$/i.test(part))
  return kept.length === 0 ? 'identity' : kept.join(', ')
}

/**
 * Whether a 404 for this request should fall back to the SPA index.
 *
 * The frontend has no router of its own beyond the one session view, but a
 * phone that lands on `/index.html`, or a link that carries a path, must still
 * open the app rather than a bare 404. API, connection, plugin and asset paths
 * keep their upstream answer: masking those would hide a real failure.
 */
function isSpaPath(req) {
  const pathname = new URL(req.url ?? '/', 'http://lan.invalid').pathname
  if (pathname === '/' || pathname === '/index.html') return false
  if (/^\/(api|connect|plugins|session-delete)(\/|$)/.test(pathname)) return false
  // A request for a file keeps its 404; a navigation-style path gets the app.
  return pathname.endsWith('/') || !/\.[a-z0-9]+$/i.test(pathname)
}

/**
 * Build the outbound request for one inbound request.
 * @param {import('node:http').IncomingMessage} req - the phone's request.
 * @param {string} origin - the loopback origin, e.g. `http://127.0.0.1:50215`.
 * @param {string} cookie - the DSH `name=value` pair to inject.
 * @returns {{options: object, rewriteDocument: boolean}} what to send, and whether
 * the response body needs the viewport rewrite.
 */
export function buildUpstreamRequest(req, origin, cookie, options = {}) {
  const target = new URL(origin)
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue
    headers[name] = value
  }

  // DSH's cookie is bound to this authority, and the /api fence accepts it.
  headers.host = target.host
  // The device cookie is replaced by DSH's own below, so the identity has to travel
  // some other way for a same-origin route to know who is asking. A client-supplied
  // value is always dropped first: the header is only trustworthy because THIS
  // process sets it after verifying the device.
  delete headers['x-dsh-phone-gateway-device']
  if (typeof options.deviceId === 'string' && options.deviceId !== '') {
    headers['x-dsh-phone-gateway-device'] = options.deviceId
  }
  if (headers.origin !== undefined) headers.origin = target.origin
  if (headers.referer !== undefined) {
    try {
      headers.referer = `${target.origin}${new URL(headers.referer).pathname}`
    } catch {
      delete headers.referer
    }
  }
  headers.cookie = cookie

  // A rewrite needs the body in clear text; DSH gzips anything over 1 KiB.
  const rewriteDocument = options.injectMobileViewport !== false && wantsDocument(req)
  if (rewriteDocument) headers['accept-encoding'] = withoutGzip(headers['accept-encoding'])

  return {
    options: {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    },
    rewriteDocument,
  }
}

/**
 * Copy an upstream response to the phone, rewriting the document body when
 * asked and always stripping the upstream's credentials.
 * @returns {Promise<void>} resolves once the response has been fully written.
 */
export async function pipeResponse(upstream, res, { rewriteDocument }) {
  const headers = {}
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue
    // Rule 2: the phone never receives a DSH credential.
    if (name === 'set-cookie') continue
    headers[name] = value
  }

  if (!rewriteDocument || !isDocumentResponse(upstream)) {
    // `content-length` stays as upstream stated it; nothing was rewritten.
    res.writeHead(upstream.statusCode ?? 502, headers)
    upstream.pipe(res)
    await new Promise((resolve, reject) => {
      upstream.on('end', resolve)
      upstream.on('error', reject)
      res.on('close', resolve)
    })
    return
  }

  const chunks = []
  for await (const chunk of upstream) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  // A compressed body cannot be rewritten without decompressing it; if DSH
  // ignored the encoding request, forward it untouched rather than corrupt it.
  if (headers['content-encoding'] !== undefined) {
    headers['content-length'] = String(body.byteLength)
    res.writeHead(upstream.statusCode ?? 502, headers)
    res.end(body)
    return
  }

  const text = body.toString('utf8')
  const rewritten = injectViewport(text)
  const out = Buffer.from(rewritten, 'utf8')
  if (rewritten !== text) {
    headers['content-length'] = String(out.byteLength)
    delete headers['content-encoding']
  }
  // The document is rewritten per request, so a cached copy must not be reused: a
  // stale one can reach the phone with the wrong viewport, which renders the whole
  // desktop layout at phone width. `no-cache` keeps revalidation, `no-store` would
  // also break the app's own back/forward cache, so this is the narrow option.
  headers['cache-control'] = 'no-cache'
  delete headers['expires']
  res.writeHead(upstream.statusCode ?? 502, headers)
  res.end(out)
}

/**
 * Forward one request to DSH and pipe the answer back.
 * @param {import('node:http').IncomingMessage} req - the phone's request.
 * @param {import('node:http').ServerResponse} res - the phone's response.
 * @param {{origin: string, cookie: string, injectMobileViewport?: boolean}} context
 */
export function proxyRequest(req, res, context) {
  const { options, rewriteDocument } = buildUpstreamRequest(
    req,
    context.origin,
    context.cookie,
    { injectMobileViewport: context.injectMobileViewport, deviceId: context.deviceId },
  )

  const upstream = httpRequest(options, (response) => {
    // A deep link into the SPA arrives as a real path but only `/` is served,
    // so an unknown page path becomes the index instead of DSH's bare 404.
    // `/api`, `/connect` and asset requests keep their upstream answer.
    if (response.statusCode === 404 && isSpaPath(req) && context.origin !== undefined) {
      response.resume()
      const retry = httpRequest(
        { ...options, path: '/' },
        (index) => {
          pipeResponse(index, res, { rewriteDocument: true }).catch(() => {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('gateway: response failed\n')
          })
        },
      )
      retry.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: DSH did not answer\n')
      })
      retry.end()
      return
    }
    pipeResponse(response, res, { rewriteDocument }).catch(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('gateway: response failed\n')
    })
  })

  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('gateway: DSH did not answer\n')
  })

  // The phone hanging up mid-upload must not leave the loopback request open.
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })

  req.pipe(upstream)
}
