/**
 * dsh-phone-gateway — a LAN door onto this same DSH desktop process.
 *
 * The design's three rules, which every step keeps:
 *  1. The gateway NEVER creates a DSH instance; it is a pipe only.
 *  2. The phone NEVER receives the DSH token; the credential lives in this
 *     process's memory and is injected per request.
 *  3. If the gateway dies, only port 8791 is affected; DSH itself is unaffected.
 *
 * Implemented so far:
 *  - step 1  skeleton, `GET /__lan/status` smoke probe (loopback only)
 *  - step 2  HTTP reverse proxy: header rewrite, DSH cookie injection, upstream
 *            `Set-Cookie` stripping, index viewport injection
 *  - step 3  WebSocket upgrade forwarding: raw byte pipe to the Remote stream mux
 *  - step 4  pairing + device allow-list: the gateway's own authentication chain
 *
 * Still to come: firewall (step 5), phone field test (step 6), cleanup (step 7).
 */

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'

import { DshAuth } from './lib/auth.js'
import { APP_PATH, appFileOf, describeApp, sendApp } from './lib/app-file.js'
import { resolveConfig } from './lib/config.js'
import { createDirectory, describeRoots, listDirectory, resolveRoots } from './lib/dirs.js'
import { encodeQr, qrRows } from './lib/qr.js'
import { busyPayload, decideSlot } from './lib/slot.js'
import { startDiscovery } from './lib/discovery.js'
import { isAllowedPeer, isLoopback, listInterfaces, normalizeAddress } from './lib/net.js'
import { DEVICE_COOKIE, DeviceStore, PAIR_PAGE_PATH, readCookie } from './lib/pair.js'
import { busyPage, devicesPage, pairPage, pickLanguage } from './lib/pair-page.js'
import { proxyRequest } from './lib/proxy.js'
import { proxyUpgrade, refuse } from './lib/ws-proxy.js'

/** Diagnostic probe path. Loopback-only, permanently. */
const STATUS_PATH = '/__lan/status'

/** Operator pages: the device list and the code issuer. Loopback-only. */
const DEVICES_PATH = '/__lan/devices'
const CODE_PATH = '/__lan/code'

/** The global the client panel reads; served from the index, so same-origin. */
const LAN_GATEWAY_GLOBAL = '__DSH_LAN_GATEWAY__'

/**
 * Same-origin route on DSH's own server returning the current download address.
 *
 * Mirrors `LAN_GATEWAY_GLOBAL` in client.js. Distinct from the gateway's own
 * `/__lan/...` routes: this one lives on the DSH port, so the page can read it
 * without crossing an origin.
 */
const ADDRESS_PATH = '/__lan/address'

/**
 * Same-origin route on DSH's own server for the pairing code.
 *
 * `GET` reports the live code (idempotent — polling it must not consume it),
 * `POST` issues a fresh one. It lives here rather than on the gateway port so the
 * panel can reach it without crossing an origin.
 */
const PAIRCARD_PATH = '/__lan/paircard'

/**
 * Same-origin route that tells a page whether it still owns the control seat.
 *
 * `/__lan/address` and the pairing card answer questions about the host; this one
 * answers "may I keep working?". Called with `wait=1` it holds the request open and
 * answers the moment the seat changes, which is what makes a kick appear
 * immediately instead of on the kicked phone's next action.
 */
const SEAT_PATH = '/__lan/seat'

/** How long one `wait=1` request is held before answering with the current state. */
const SEAT_WAIT_MS = 25_000

/**
 * Where an evicted device is redirected.
 *
 * A redirect rather than a 403 body, because the client that most needs to leave is
 * the one running an older build, which has no seat watcher of its own. Every
 * WebView follows a 302, so the enforcement does not depend on what the phone runs.
 */
const BUSY_PATH = '/__lan/busy'

/**
 * Per-origin `localStorage` keys that mark a one-time welcome dialog as seen.
 *
 * A LAN page's origin contains the machine's address, so every network change is a
 * brand-new origin with empty storage — and those dialogs pop up again on the phone
 * each time. Re-marking them in the document head, before the SPA boots, keeps them
 * out of the way. `127.0.0.1` is skipped so the desktop keeps its own onboarding.
 *
 * This is a compatibility shim, not a feature of those plugins: if one of them
 * renames its key, `tools/test-lan-welcome.mjs` fails instead of the dialog
 * quietly coming back.
 */
const WELCOME_STORAGE_KEYS = ['dsh-windows-mcp:welcome']

/**
 * Same-origin route the phone's workspace picker talks to.
 *
 * The native folder chooser cannot describe itself to a phone — it draws on the
 * host's display — so a LAN client gets a web picker instead, confined to
 * `allowedWorkspaceRoots`.
 */
const DIRS_PATH = '/__lan/dirs'

/**
 * Installed in the document head for LAN pages only.
 *
 * `dsh-client-ui-directory-picker-native` reads this global in its `apply` and uses
 * `desktop.pick()` in place of the host RPC. Defining it here therefore replaces the
 * host's native chooser with the web one, with no slot to fight over and no duplicate
 * dialog. The desktop shell defines the same global from its preload script, so it is
 * left alone: only `http:` pages that are not loopback are touched.
 */
const DIRECTORY_PICKER_SHIM = `(function(){try{`
  + `if(location.protocol!=='http:')return;`
  + `var h=location.hostname;`
  + `if(h==='127.0.0.1'||h==='localhost'||h==='::1'||h==='[::1]')return;`
  + `if(globalThis.__DSH_DIRECTORY_PICKER__!==undefined)return;`
  + `globalThis.__DSH_DIRECTORY_PICKER__={pick:function(){`
  + `return new Promise(function(resolve){`
  + `var impl=globalThis.__DSH_LAN_PICK_DIRECTORY__;`
  + `if(typeof impl!=='function'){resolve(null);return}`
  + `impl(resolve);`
  + `})}};`
  + `}catch(e){}})();`

/**
 * Watches the control seat from the document head, before any plugin bundle.
 *
 * This has to run even when the app itself is failing: a phone that has just been
 * evicted keeps making requests that now answer 403, which can leave the shell
 * showing an empty page that never gets around to navigates away. A plain script in
 * the head depends on nothing and leaves immediately. The client half installs the
 * same watcher and skips when this flag is already set, so only one poll runs.
 */
const SEAT_WATCH_SCRIPT = `(function(){try{`
  + `if(location.protocol!=='http:')return;`
  + `var h=location.hostname;`
  + `if(h==='127.0.0.1'||h==='localhost'||h==='::1'||h==='[::1]')return;`
  + `if(globalThis.__DSH_LAN_SEAT_WATCH__===true)return;`
  + `globalThis.__DSH_LAN_SEAT_WATCH__=true;`
  + `var poll=function(){`
  + `fetch('/__lan/seat?wait=1',{cache:'no-store'})`
  + `.then(function(r){return r.json()})`
  + `.then(function(s){`
  + `if(s&&s.busy===true){location.replace('/?kicked='+Date.now());return}`
  + `setTimeout(poll,1500);`
  + `})`
  + `.catch(function(){setTimeout(poll,1500)});`
  + `};`
  + `poll();`
  + `}catch(e){}})();`

/**
 * User-Agent marker the Android app appends to its WebView.
 *
 * The phone app renders the pairing page too, and offering "install the app" to
 * someone already inside it is noise. A WebView's stock UA carries `; wv`, which
 * any app can produce, so the app appends this explicit tag instead.
 */
const APP_UA_TAG = 'DSHLanApp'

/** Whether this request comes from the phone app rather than a browser. */
function isAppRequest(req) {
  const agent = req.headers['user-agent']
  return typeof agent === 'string' && agent.includes(APP_UA_TAG)
}

/** Largest request body the gateway buffers itself (pairing JSON only). */
const MAX_SELF_BODY_BYTES = 8 * 1024

/** A port held by a dying process usually frees within a few seconds. */
const BIND_RETRY_MS = 4000
const MAX_BIND_ATTEMPTS = 5

/**
 * The address to bind.
 *
 * `bindAll: true` (the default) binds every interface, which is what a phone on
 * the hotspot needs. `bindAll: false` restricts the listener to this machine's
 * first non-loopback IPv4 address, so the gateway is reachable from that one
 * network only — useful when the laptop sits on several networks at once.
 */
function bindAddress(config) {
  if (config.bindAll !== false) return '0.0.0.0'
  const first = listInterfaces().find((entry) => entry.family === 'IPv4')
  if (first === undefined) {
    // No usable interface: refusing to bind beats silently falling back to
    // every interface, which is the opposite of what this setting asks for.
    throw new Error('lan-gateway: bindAll is false but no non-loopback IPv4 interface exists')
  }
  return first.address
}

/**
 * Guards every response writer below.
 *
 * `writeHead` throws `ERR_HTTP_HEADERS_SENT` once a status line is out, and a throw
 * inside a `.catch` handler becomes an unhandled rejection — which takes the HOST
 * PROCESS down, not just this request. That is the same failure mode as the two
 * earlier crashes, so the writers themselves refuse to double-write instead of
 * relying on every call site remembering a `headersSent` check.
 *
 * @returns {boolean} true when the response can no longer be written to.
 */
function alreadyAnswered(res) {
  if (!res.headersSent) return false
  // Nothing can be added to a started response; dropping the socket is the only
  // honest ending, and the client already has a partial answer.
  res.destroy()
  return true
}

/** Write one JSON body, owning the whole response lifecycle. */
function writeJson(res, status, value) {
  if (alreadyAnswered(res)) return
  const text = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Plain-text answer for the gateway's own refusals. */
function writeText(res, status, body) {
  if (alreadyAnswered(res)) return
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** One HTML page, never cached. */
function writeHtml(res, status, html) {
  if (alreadyAnswered(res)) return
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/** Read a small JSON body, refusing anything larger than the gateway buffers. */
async function readJsonBody(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_SELF_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * `GET /__lan/status` — the smoke probe kept from step 1.
 *
 * It reports the loopback port, whether the DSH cookie still authenticates, the
 * addresses a phone could dial, and how many devices are paired. Loopback-only:
 * it exposes the listener port and cookie state, which is diagnostics for the
 * operator at the computer, never something a paired device should read.
 */
async function answerStatus(res, ctx, config, auth, devices, holderId = null) {
  let cookieOk = false
  let cookieVerified = false
  let error = auth.lastError
  try {
    const status = await auth.verify()
    cookieVerified = status === 200
    cookieOk = cookieVerified
    error = cookieOk ? null : `replaying the cached cookie answered ${String(status)}`
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const app = await describeApp(config).catch(() => ({ available: false, reason: 'unreadable' }))
  writeJson(res, 200, {
    port: ctx.webServer.port ?? null,
    cookieOk,
    cookieVerified,
    cookieName: auth.cookieName,
    interfaces: listInterfaces(),
    devices: {
      paired: devices.list().length,
      // Which phone owns the role, and which one is driving the session right now.
      // Both are needed to diagnose "two phones seem connected at once".
      primary: devices.primaryId,
      inUse: holderId,
      storeError: devices.loadError === null ? null : String(devices.loadError?.message ?? devices.loadError),
    },
    app: {
      available: app.available === true,
      path: APP_PATH,
      size: app.available ? app.size : null,
      version: app.available ? app.version : null,
      builtAt: app.available ? app.builtAt : null,
      reason: app.available ? null : String(app.reason ?? 'unknown'),
    },
    error,
  })
}

/**
 * The operator's loopback-only pages.
 * @returns {boolean} true when this request was answered here.
 */
async function handleOperatorRoute(req, res, pathname, devices, lang, config, holderId = null) {
  if (pathname === DEVICES_PATH) {
    if (req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}))
      if (typeof body.revoke === 'string') {
        const removed = await devices.revoke(body.revoke)
        writeJson(res, 200, { ok: removed })
        return true
      }
      // Designating the primary is the operator's decision, so it lives on this
      // page (loopback only) beside revoke.
      if (typeof body.setPrimary === 'string') {
        const moved = await devices.setPrimary(body.setPrimary)
        writeJson(res, 200, { ok: moved })
        return true
      }
      writeJson(res, 400, { ok: false, error: 'expected { revoke } or { setPrimary }' })
      return true
    }
    const app = await describeApp(config).catch(() => ({ available: false }))
    // The operator reads this page on the computer, so the link must name a LAN
    // address the phone can reach — the request's own host is loopback here.
    const lan = listInterfaces().find((entry) => entry.family === 'IPv4')
    const appUrl = app.available && lan !== undefined
      ? `http://${lan.address}:${String(config.port)}${APP_PATH}`
      : null
    let qrRowsValue = null
    if (appUrl !== null) {
      try {
        qrRowsValue = qrRows(encodeQr(appUrl, { ecLevel: 'M' }))
      } catch {
        qrRowsValue = null
      }
    }
    writeHtml(
      res,
      200,
      devicesPage(devices.list(), devices.codeStatus(), lang, appUrl, app, qrRowsValue, devices.primaryId, holderId),
    )
    return true
  }
  if (pathname === CODE_PATH) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'POST only' })
      return true
    }
    const issued = await devices.issueCode()
    writeJson(res, 200, { ok: true, ...issued })
    return true
  }
  return false
}

/**
 * Mount the gateway listener. Everything hangs off one `ctx.effect`, so
 * disposing the plugin closes 8791 immediately and leaves DSH untouched.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.('lan-gateway: disabled by config')
    return
  }

  /** Owner of the DSH credential; one instance per activation. */
  const auth = new DshAuth(ctx)

  /** Paired devices and the pairing codes; persisted outside the workspace. */
  const devices = new DeviceStore()
  devices.setDeviceTtlDays(config.deviceTtlDays)

  let activeSession = null

  /** Held seat queries, woken by {@link notifySeat} the moment the seat moves. */
  const seatWaiters = new Set()

  /**
   * Whether one device may keep working, and why not.
   *
   * @param {string|null} deviceId - the asking device, or null when unpaired.
   * @returns {{deviceId: string|null, role: string, busy: boolean}} the answer
   * the page acts on.
   */
  const seatStateFor = (deviceId) => {
    const primaryId = devices.primaryId
    if (deviceId === null) {
      // Unpaired or loopback: the device gate handles those separately, and a
      // page without a credential is never "busy" — it is stopped elsewhere.
      return { deviceId: null, role: 'none', busy: false }
    }
    const verdict = decideSlot({
      holder: currentHolder(),
      deviceId,
      primaryId,
    })
    return {
      deviceId,
      role: deviceId === primaryId ? 'primary' : 'secondary',
      busy: verdict === 'busy',
    }
  }

  /**
   * The device holding the seat, or null.
   *
   * A revoked device no longer exists, so a seat it left behind must not block
   * anyone: otherwise revoking the primary's phone — or reinstalling it, which
   * creates a new device id — would leave the gateway permanently unusable.
   */
  const currentHolder = () => {
    if (activeSession === null) return null
    if (!devices.list().some((entry) => entry.id === activeSession.deviceId)) {
      activeSession = null
      return null
    }
    return activeSession.deviceId
  }

  /**
   * Claim the seat for a device, kicking whoever held it.
   *
   * Only reachable when {@link decideSlot} answered `take`, i.e. the seat was
   * free or the primary is taking it back from a secondary.
   *
   * @param {string} deviceId - the device claiming it.
   * @param {import('node:net').Socket|null} socket - its upgrade socket, if any.
   */
  const claimSeat = (deviceId, socket) => {
    const previous = activeSession
    activeSession = { deviceId, socket }
    if (previous === null || previous.deviceId === deviceId) {
      notifySeat()
      return
    }
    ctx.logger?.info?.('lan-gateway: the primary took the control slot back')
    // Drop the previous holder's WebSocket; its next HTTP request is refused
    // by the same check, so the page stops instead of carrying on silently.
    try {
      previous.socket?.destroy()
    } catch {
      // Already gone.
    }
    notifySeat()
  }

  /**
   * Wake every held seat query, so a freshly evicted page learns about it at
   * once instead of on its next click.
   */
  const notifySeat = () => {
    for (const waiter of [...seatWaiters]) waiter()
  }

  /**
   * Everything the page needs to show the phone's download address.
   *
   * Synchronous on purpose: it feeds both the index injection (which must answer
   * on the spot) and the refresh route. `existsSync` and the QR build are cheap,
   * and the value has to reflect a rebuild or a network change immediately.
   *
   * @returns {{port: number, lan: string|null, appPath: string, appAvailable: boolean,
   *   url: string|null, qr: {size: number, rows: string[]}|null}} the payload.
   */
  const addressPayload = () => {
    const lan = listInterfaces().find((entry) => entry.family === 'IPv4')
    // A sync existence check: this runs per index render, and the answer must
    // reflect a rebuild without restarting the plugin.
    const appAvailable = existsSync(appFileOf(config))
    const url = lan === undefined ? null : `http://${lan.address}:${String(config.port)}${APP_PATH}`
    // The code encodes the address the PHONE must open, so it is built here rather
    // than in the page: the page cannot know this machine's interfaces.
    let qr = null
    if (url !== null && appAvailable) {
      try {
        const code = encodeQr(url, { ecLevel: 'M' })
        qr = { size: code.size, rows: qrRows(code) }
      } catch (error) {
        // A payload too large for the supported versions must not break the page.
        ctx.logger?.warn?.(`lan-gateway: cannot build the QR code: ${String(error)}`)
      }
    }
    return {
      port: config.port,
      lan: lan?.address ?? null,
      appPath: APP_PATH,
      appAvailable,
      url,
      qr,
    }
  }

  // Hand the phone's download address to the PAGE, instead of making the page ask.
  //
  // The panel runs on three origins — the desktop shell's `dsh-app://app`, a
  // desktop browser on the DSH port, and the phone on the gateway — and only the
  // last one shares an origin with the gateway. A `fetch` of the loopback status
  // endpoint from the other two is a cross-origin request the browser blocks,
  // which is exactly how the panel ended up reporting "cannot read the address".
  //
  // `webserver/index-inject` renders this into the served index as
  // `globalThis["__DSH_LAN_GATEWAY__"] = {...}`, so it is same-origin for every
  // client, needs no CORS, and is recomputed on every page load.
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: LAN_GATEWAY_GLOBAL,
      value: addressPayload(),
    })
    // Before every other row: a phone that lost the seat must leave this document
    // even if nothing else on the page is still working.
    table.push({ kind: 'script', placement: 'head', text: SEAT_WATCH_SCRIPT })
    if (config.hideLanWelcomeHints) {
      // Runs in the document head, before any plugin bundle, so the dialog's own
      // "already seen?" check finds the flag set.
      table.push({
        kind: 'script',
        placement: 'head',
        text: `(function(){try{`
          + `var h=location.hostname;`
          + `if(h==='127.0.0.1'||h==='localhost'||h==='::1'||h==='[::1]')return;`
          + `var k=${JSON.stringify(WELCOME_STORAGE_KEYS)};`
          + `for(var i=0;i<k.length;i++){try{localStorage.setItem(k[i],'1')}catch(e){}}`
          + `}catch(e){}})();`,
      })
    }
    // Swap the host's native folder chooser for the confined web picker on LAN
    // pages. The roots are derived from this machine, so this works on any install
    // without configuration; `remoteWorkspacePicker: false` restores the old path.
    if (config.remoteWorkspacePicker) {
      table.push({ kind: 'script', placement: 'head', text: DIRECTORY_PICKER_SHIM })
    }
  })

  // The same payload on demand, so the panel can refresh the address after the
  // machine joins a different network — otherwise the injected copy is as fresh as
  // the last page load and the operator has to reload the whole app.
  //
  // This is a route on DSH's OWN server, so it shares the page's origin in every
  // runtime and needs no CORS. Registration can throw if another plugin claimed
  // the path; that must never take activation down, and the panel still falls back
  // to re-reading the index.
  ctx.effect(() => {
    let dispose = null
    try {
      dispose = ctx.webServer.register({
        kind: 'exact',
        path: ADDRESS_PATH,
        resource: async () =>
          new Response(JSON.stringify(addressPayload()), {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          }),
      })
    } catch (error) {
      ctx.logger?.warn?.(`lan-gateway: cannot register ${ADDRESS_PATH}: ${String(error)}`)
    }
    return () => {
      if (dispose !== null) dispose()
    }
  })

  /**
   * Where the phone may create a workspace.
   *
   * Configured roots confine it. With nothing configured, every drive is offered —
   * the same reach the operating system's folder dialog has, which is what makes the
   * picker usable on any machine without configuration.
   *
   * @returns {Promise<string[]>} canonical roots.
   */
  const workspaceRootCandidates = () => resolveRoots(config.allowedWorkspaceRoots)

  // The workspace picker's backing service.
  //
  // A `handler` route because creating a folder is a POST, and `resource` routes
  // answer GET/HEAD only.
  ctx.effect(() => {
    let dispose = null
    /** Canonical roots; refreshed per request so a new workspace or drive lands. */
    let rootsCache = []
    let rootsAt = 0
    const roots = async () => {
      const now = Date.now()
      if (now - rootsAt > 5000) {
        rootsCache = await resolveRoots(workspaceRootCandidates())
        rootsAt = now
      }
      return rootsCache
    }
    try {
      dispose = ctx.webServer.register({
        kind: 'exact',
        path: DIRS_PATH,
        handler: (req, res) => {
          const run = async () => {
            const resolved = await roots()
            if (req.method === 'GET' || req.method === 'HEAD') {
              const url = new URL(req.url ?? DIRS_PATH, 'http://lan.invalid')
              const rootIndex = Number(url.searchParams.get('root') ?? '0')
              const requested = url.searchParams.get('path') ?? ''
              const listed = await listDirectory(resolved, rootIndex, requested)
              if (listed.ok !== true) {
                writeJson(res, 200, { ...describeRoots(resolved), ...listed })
                return
              }
              writeJson(res, 200, { ...describeRoots(resolved), ...listed })
              return
            }
            if (req.method !== 'POST') {
              res.setHeader('allow', 'GET, HEAD, POST')
              writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            const body = await readJsonBody(req).catch(() => ({}))
            const rootIndex = Number(body?.root ?? 0)
            const requested = typeof body?.path === 'string' ? body.path : ''
            const created = await createDirectory(resolved, rootIndex, requested, body?.name)
            if (created.ok !== true) {
              writeJson(res, 200, created)
              return
            }
            ctx.logger?.info?.(`lan-gateway: created a workspace directory (${String(created.path)})`)
            writeJson(res, 200, created)
          }
          run().catch((error) => {
            ctx.logger?.warn?.(`lan-gateway: ${DIRS_PATH} failed: ${String(error)}`)
            if (!res.headersSent) writeJson(res, 500, { ok: false, error: 'internal' })
          })
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`lan-gateway: cannot register ${DIRS_PATH}: ${String(error)}`)
    }
    return () => {
      if (dispose !== null) dispose()
    }
  })

  // The pairing code, so the panel can show it directly instead of sending the
  // operator to another page to press a button and read it there.
  //
  // Same-origin for the same reason as the address route. `GET` is idempotent —
  // opening the panel must not silently invalidate a code the operator already
  // read out — and `POST` is the explicit "give me a new one".
  ctx.effect(() => {
    let dispose = null
    // A `resource` route answers GET and HEAD only — any other method gets 405
    // before the handler runs. Minting a code is a POST, so this one is a raw
    // `handler` route that owns the method dispatch itself.
    try {
      dispose = ctx.webServer.register({
        kind: 'exact',
        path: PAIRCARD_PATH,
        handler: (req, res) => {
          const method = req.method ?? 'GET'
          if (method === 'GET' || method === 'HEAD') {
            writeJson(res, 200, devices.codeStatus() ?? { code: null })
            return
          }
          if (method !== 'POST') {
            res.setHeader('allow', 'GET, HEAD, POST')
            writeJson(res, 405, { code: null, error: 'method-not-allowed' })
            return
          }
          devices
            .issueCode()
            .then((issued) => writeJson(res, 200, issued))
            .catch((error) => {
              ctx.logger?.warn?.(`lan-gateway: cannot issue a code: ${String(error)}`)
              if (!res.headersSent) writeJson(res, 500, { code: null, error: 'internal' })
            })
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`lan-gateway: cannot register ${PAIRCARD_PATH}: ${String(error)}`)
    }
    return () => {
      if (dispose !== null) dispose()
    }
  })

  // The seat query the page long-polls. On the DSH server for the same reason as
  // the routes above: it shares the page's origin in every runtime.
  //
  // `wait=1` holds the answer until the seat changes, so an evicted phone is told
  // within a fraction of a second instead of discovering it on its next click.
  ctx.effect(() => {
    let dispose = null
    try {
      dispose = ctx.webServer.register({
        kind: 'exact',
        path: SEAT_PATH,
        handler: (req, res) => {
          // The gateway sets this after verifying the device; the cookie itself is
          // stripped before the request reaches DSH.
          const header = req.headers['x-dsh-phone-gateway-device']
          const headerId = typeof header === 'string' && header !== '' ? header : null
          const deviceId = headerId !== null && devices.list().some((entry) => entry.id === headerId)
            ? headerId
            : null
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('allow', 'GET, HEAD')
            writeJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          const answer = () => {
            if (!res.headersSent) writeJson(res, 200, seatStateFor(deviceId))
          }
          const url = new URL(req.url ?? SEAT_PATH, 'http://lan.invalid')
          if (url.searchParams.get('wait') !== '1') {
            answer()
            return
          }

          let finished = false
          const finish = () => {
            if (finished) return
            finished = true
            seatWaiters.delete(finish)
            clearTimeout(timer)
            answer()
          }
          const timer = setTimeout(finish, SEAT_WAIT_MS)
          timer.unref?.()
          seatWaiters.add(finish)
          // A phone that navigates away must not leave a waiter behind.
          res.on('close', () => {
            finished = true
            seatWaiters.delete(finish)
            clearTimeout(timer)
          })
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`lan-gateway: cannot register ${SEAT_PATH}: ${String(error)}`)
    }
    return () => {
      if (dispose !== null) dispose()
    }
  })

  /**
   * Answer a device that lost the seat.
   *
   * A navigation is REDIRECTED to the busy page rather than handed a 403 body: the
   * redirect is followed by every WebView, including one running an older build that
   * has no seat watcher of its own. Its assets are refused outright, so a stale page
   * cannot keep painting itself from cache either.
   *
   * `/api/*` callers get JSON, because the app surfaces that as an error rather than
   * a silent reload loop.
   */
  const refuseBusy = (req, res, pathname) => {
    if (pathname.startsWith('/api/')) {
      writeJson(res, 403, busyPayload())
      return
    }
    const dest = req.headers['sec-fetch-dest']
    const accept = req.headers.accept
    const wantsDocument = dest === 'document' || (typeof accept === 'string' && accept.includes('text/html'))
    if (wantsDocument && pathname !== BUSY_PATH) {
      res.writeHead(302, { location: `${BUSY_PATH}?t=${String(Date.now())}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    writeHtml(res, 403, busyPage(pickLanguage(req.headers['accept-language'])))
  }

  ctx.effect(
    async () => {
      // Load the signing key BEFORE the listener accepts anything: `verify` is
      // synchronous and must never run against an uninitialized secret.
      await devices.load()

      /**
       * The one device currently driving the session, or null.
       *
       * `socket` is null when the seat is held by a device that is only making
       * HTTP requests; a WebSocket holder also carries the socket to kick.
       */

      const handle = (req, res) => {
        try {
          routeRequest(req, res)
        } catch (error) {          // Rule 3: nothing a request does may take DSH down. Every unexpected
          // throw ends here, after the gateway has answered or closed.
          ctx.logger?.error?.(`lan-gateway: request failed: ${String(error)}`)
          if (!res.headersSent) writeText(res, 500, 'gateway: internal error\n')
          else res.destroy()
        }
      }

      const routeRequest = (req, res) => {
        const peer = normalizeAddress(req.socket.remoteAddress)
        const pathname = new URL(req.url ?? '/', 'http://lan.invalid').pathname
        const loopback = isLoopback(peer)

        // ---- operator surface: this computer only -------------------------
        if (pathname === STATUS_PATH) {
          if (!loopback) {
            writeText(res, 403, 'status is available from this computer only\n')
            return
          }
          answerStatus(res, ctx, config, auth, devices, currentHolder()).catch(() => {
            if (!res.headersSent) writeJson(res, 500, { error: 'status failed' })
          })
          return
        }

        if (pathname === DEVICES_PATH || pathname === CODE_PATH) {
          if (!loopback) {
            writeText(res, 403, 'device management is available from this computer only\n')
            return
          }
          handleOperatorRoute(
            req,
            res,
            pathname,
            devices,
            pickLanguage(req.headers['accept-language']),
            config,
            // Which device is driving the session right now, so the seat's state is
            // visible on the page rather than only in the log.
            currentHolder(),
          ).catch(
            (error) => {
              ctx.logger?.warn?.(`lan-gateway: operator route failed: ${String(error)}`)
              if (!res.headersSent) writeJson(res, 500, { ok: false })
            },
          )
          return
        }

        // ---- the LAN gate: subnet restriction, before any work --------------
        if (!isAllowedPeer(peer, config)) {
          writeText(res, 403, 'this device is not on a network the gateway serves\n')
          return
        }

        // The download link handed to a phone uses this request's own authority.
        // When the phone is the client, that is already the LAN address — no
        // interface guessing, and it stays correct after a network change.
        // HTTP/1.0 may omit Host; falling back to the peer keeps the link usable
        // instead of producing `http://undefined/...`.
        const authority = typeof req.headers.host === 'string' && req.headers.host !== ''
          ? req.headers.host
          : `${peer}:${String(config.port)}`
        const appUrl = `http://${authority}${APP_PATH}`

        // ---- pairing: reachable while unpaired, by design -------------------
        if (pathname === PAIR_PAGE_PATH) {
          if (req.method === 'GET') {
            // The installer link is rendered only when a build actually exists,
            // so the phone never taps a dead button.
            describeApp(config)
              .then((app) => {
                writeHtml(
                  res,
                  200,
                  pairPage(pickLanguage(req.headers['accept-language']), app.available ? appUrl : null, app, isAppRequest(req)),
                )
              })
              .catch(() => {
                if (!res.headersSent) {
                  writeHtml(res, 200, pairPage(pickLanguage(req.headers['accept-language']), null, null, isAppRequest(req)))
                }
              })
            return
          }
          if (req.method === 'POST') {
            readJsonBody(req)
              .then((body) => devices.pair(body?.code, body?.label))
              .then((result) => {
                if (result.error !== undefined) {
                  writeJson(res, 403, { ok: false, error: result.error })
                  return
                }
                res.setHeader('set-cookie', DeviceStore.deviceCookie(result.cookie, result.expiresAt))
                writeJson(res, 200, { ok: true, deviceId: result.deviceId, expiresAt: result.expiresAt })
                ctx.logger?.info?.('lan-gateway: paired a new device')
              })
              .catch((error) => {
                ctx.logger?.warn?.(`lan-gateway: pairing failed: ${String(error)}`)
                if (!res.headersSent) writeJson(res, 400, { ok: false, error: 'bad-request' })
              })
            return
          }
          writeText(res, 405, 'GET or POST only\n')
          return
        }

        // ---- the phone app, downloadable BEFORE pairing ---------------------
        // Placed after the subnet gate but before the device gate: the app and a
        // browser keep separate cookie jars, so requiring a paired browser to
        // fetch the installer would make every first-time user pair twice.
        if (pathname === APP_PATH) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          describeApp(config)
            .then((app) => {
              if (!app.available) {
                writeText(res, 404, 'gateway: the phone app has not been built yet\n')
                return undefined
              }
              ctx.logger?.info?.(
                `lan-gateway: serving the phone app (${String(app.size)} bytes) to ${String(peer)}`,
              )
              return sendApp(req, res, app)
            })
            .catch((error) => {
              ctx.logger?.warn?.(`lan-gateway: cannot serve the app: ${String(error)}`)
              if (!res.headersSent) writeText(res, 500, 'gateway: cannot read the app\n')
            })
          return
        }

        // ---- the landing page for an evicted device -------------------------
        // Reached by redirect from any request a busy device makes, and by the page's
        // own retry. It answers the device's CURRENT state, so once the seat frees up
        // the retry sends it back into the app without the operator doing anything.
        if (pathname === BUSY_PATH) {
          const device = devices.verify(readCookie(req.headers.cookie, DEVICE_COOKIE))
          if (device === undefined) {
            writeHtml(res, 401, pairPage(pickLanguage(req.headers['accept-language']), null, null, isAppRequest(req)))
            return
          }
          const verdict = decideSlot({
            holder: currentHolder(),
            deviceId: device.id,
            primaryId: devices.primaryId,
          })
          if (verdict === 'busy') {
            writeHtml(res, 200, busyPage(pickLanguage(req.headers['accept-language'])))
            return
          }
          // Nobody is using it any more: go back to the app.
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
          res.end()
          return
        }

        // ---- the gateway's own authentication chain -------------------------
        // Pairing is required whenever the request did not come from this
        // computer: a phone without a valid device cookie gets the pair page,
        // which is the ONLY thing it can reach. Assets are gated too, not just
        // navigation: `/api` shares this path, and a served asset would confirm
        // the DSH build to an unpaired device.
        let deviceId = null
        if (!loopback) {
          const device = devices.verify(readCookie(req.headers.cookie, DEVICE_COOKIE))
          if (device === undefined) {
            // Same page, same installer link: a phone that lands here unpaired
            // must still be able to install the app.
            describeApp(config)
              .then((app) => {
                writeHtml(
                  res,
                  401,
                  pairPage(pickLanguage(req.headers['accept-language']), app.available ? appUrl : null, app, isAppRequest(req)),
                )
              })
              .catch(() => {
                if (!res.headersSent) {
                  writeHtml(res, 401, pairPage(pickLanguage(req.headers['accept-language']), null, null, isAppRequest(req)))
                }
              })
            return
          }
          deviceId = device.id
          devices.touch(device.id)

          // ---- one control slot ---------------------------------------------
          // Every request, not just the upgrade: a device that lost the seat has
          // to stop working, not merely stop streaming.
          const verdict = decideSlot({
            holder: currentHolder(),
            deviceId: device.id,
            primaryId: devices.primaryId,
          })
          if (verdict === 'busy') {
            // The seat query itself must stay reachable, or a kicked page could
            // never learn it may come back.
            if (pathname === SEAT_PATH) {
              // fall through to the proxy, which serves the long poll
            } else {
              ctx.logger?.info?.(`lan-gateway: refused a busy secondary on ${pathname}`)
              refuseBusy(req, res, pathname)
              return
            }
          }
          // Only real usage claims the seat. The `/__lan/*` helpers are queries
          // (the seat poll, the address, the pairing card, the directory listing)
          // and must not make a watching phone look like the active one — the
          // kicked phone's own poll would otherwise fight the primary for it.
          const isHelperPath = pathname.startsWith('/__lan/')
          if (verdict === 'take' && !isHelperPath) {
            claimSeat(device.id, activeSession?.socket ?? null)
          }
        }

        // ---- the proxy itself ----------------------------------------------
        auth
          .cookie()
          .then((cookie) => {
            proxyRequest(req, res, {
              origin: ctx.webServer.getOrigin(),
              cookie,
              injectMobileViewport: config.injectMobileViewport,
              // The proxy replaces the cookie, so the seat route learns who is
              // asking from this header instead.
              deviceId,
            })
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`lan-gateway: cannot reach DSH: ${reason}`)
            writeText(res, 502, `gateway: cannot reach DSH (${reason})\n`)
          })
      }

      const server = createServer(handle)

      // WebSocket upgrades: the same subnet gate and the same device check, then
      // a raw byte pipe to DSH.
      server.on('upgrade', (req, socket, head) => {
        try {
          handleUpgrade(req, socket, head)
        } catch (error) {
          // Same rule as HTTP: an upgrade failure closes that socket only.
          ctx.logger?.error?.(`lan-gateway: upgrade failed: ${String(error)}`)
          socket.destroy()
        }
      })

      const handleUpgrade = (req, socket, head) => {
        const peer = normalizeAddress(socket.remoteAddress)
        if (!isAllowedPeer(peer, config)) {
          refuse(socket)
          return
        }
        // ---- one control slot ------------------------------------------------
        // The phone that holds the mux is the one driving the session. Loopback is
        // the computer itself and never takes the slot.
        if (!isLoopback(peer)) {
          const device = devices.verify(readCookie(req.headers.cookie, DEVICE_COOKIE))
          if (device === undefined) {
            refuse(socket)
            return
          }
          devices.touch(device.id)
          const verdict = decideSlot({
            holder: currentHolder(),
            deviceId: device.id,
            primaryId: devices.primaryId,
          })
          if (verdict === 'busy') {
            ctx.logger?.info?.('lan-gateway: refused a busy secondary upgrade')
            refuse(socket)
            return
          }
          claimSeat(device.id, socket)
        }
        socket.on('close', () => {
          if (activeSession !== null && activeSession.socket === socket) {
            activeSession = null
            ctx.logger?.info?.('lan-gateway: the control slot is free')
          }
        })

        auth
          .cookie()
          .then((cookie) => {
            proxyUpgrade(req, socket, head, { origin: ctx.webServer.getOrigin(), cookie })
          })
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`lan-gateway: cannot reach DSH for upgrade: ${reason}`)
            refuse(socket)
          })
      }

      // Rule 3: a bind failure (most likely EADDRINUSE from a previous
      // instance's TIME_WAIT sockets) is logged and retried; the fiber stays
      // healthy, so DSH itself boots whether or not the gateway gets a port.
      let retryTimer = null
      let stopped = false
      let attempts = 0
      // Resolved once: a retry must target the same interface the log names.
      const host = bindAddress(config)

      const listen = () =>
        new Promise((resolve) => {
          if (stopped) {
            resolve(false)
            return
          }
          const onFailure = (error) => {
            const code = error?.code
            ctx.logger?.error?.(
              `lan-gateway: cannot listen on ${host}:${String(config.port)}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
            // A port held by a previous run frees itself; retry a few times
            // before giving up for this activation.
            if (code === 'EADDRINUSE' && attempts < MAX_BIND_ATTEMPTS) {
              attempts += 1
              retryTimer = setTimeout(() => {
                retryTimer = null
                void listen().then(resolve)
              }, BIND_RETRY_MS)
              ctx.logger?.info?.(
                `lan-gateway: retrying in ${String(BIND_RETRY_MS)} ms (attempt ${String(attempts)}/${String(MAX_BIND_ATTEMPTS)})`,
              )
              retryTimer.unref?.()
              return
            }
            resolve(false)
          }
          server.once('error', onFailure)
          server.listen(config.port, host, () => {
            server.off('error', onFailure)
            server.on('error', (error) => {
              ctx.logger?.warn?.(`lan-gateway: listener error: ${String(error)}`)
            })
            ctx.logger?.info?.(
              `lan-gateway: listening on ${host}:${String(config.port)} ` +
                `(${STATUS_PATH} and ${DEVICES_PATH} on this computer only)`,
            )
            resolve(true)
          })
        })

      const bound = await listen()

      // Discovery is an optimisation for the mobile app: a failure here means
      // the app falls back to a typed address, never that DSH fails to boot.
      const discovery = await startDiscovery({
        httpPort: config.port,
        config,
        log: (message) => ctx.logger?.info?.(message),
      }).catch((error) => {
        ctx.logger?.warn?.(`lan-gateway: discovery did not start: ${String(error)}`)
        return null
      })

      return async () => {
        stopped = true
        if (retryTimer !== null) clearTimeout(retryTimer)
        await discovery?.close().catch(() => undefined)
        if (!bound) return
        await new Promise((resolve) => {
          server.close(() => {
            resolve()
          })
          server.closeAllConnections()
        })
      }
    },
    'lan-gateway: listener',
  )
}

/** The gateway needs the listener port and one cookie exchange; both must exist. */
export const inject = ['webServer', 'connection']
