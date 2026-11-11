/**
 * Phone gateway — browser half.
 *
 * A single action button at the sidebar foot (`sidebar.footer.action`), beside
 * Settings. It opens a small panel that explains how to use the gateway on a
 * phone and links to the pairing page, because that page lives on the gateway's
 * own port (8791) and is otherwise undiscoverable from inside the Harness UI.
 *
 * The slot is a `list`, so this registration adds one entry without shadowing
 * anything the shell already draws there.
 */

window.__ModuleLoader__.load({
  id: 'dsh-phone-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The gateway's own pages. Same machine, different port. */
    /**
     * The gateway's own port. The panel is rendered by three clients (desktop
     * shell, desktop browser, phone) and only the gateway serves these routes, so
     * the port is what identifies it — see `gatewayOrigin`.
     */
    const GATEWAY_PORT = '8791'
    /** Gateway routes; mirrored from index.js / lib/app-file.js. */
    const STATUS_PATH = '/__lan/status'
    const DEVICES_PATH = '/__lan/devices'
    const APP_PATH = '/__lan/app'
    /** Same-origin route on DSH's own server; see ADDRESS_PATH in index.js. */
    const ADDRESS_PATH = '/__lan/address'
    /** Same-origin route for the pairing code; see PAIRCARD_PATH in index.js. */
    const PAIRCARD_PATH = '/__lan/paircard'
    /** Same-origin confined directory service; see DIRS_PATH in index.js. */
    const DIRS_PATH = '/__lan/dirs'
    /** Same-origin seat query; see SEAT_PATH in index.js. */
    const SEAT_PATH = '/__lan/seat'

    /**
     * Watch the control seat and leave the page the instant it is taken.
     *
     * Dropping the phone's WebSocket alone was not enough: the page keeps everything
     * it already rendered, so an evicted phone only learned about it on its next
     * action. This long-poll is woken by the host the moment the seat moves, and the
     * answer is a full navigation — which destroys the app and everything it had
     * loaded, rather than merely stopping it from updating.
     *
     * Runs on LAN origins only: the desktop owns the machine and is never evicted.
     */
    function startSeatWatcher() {
      const host = window.location.hostname
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
      if (loopback) return
      if (globalThis.__DSH_LAN_SEAT_WATCH__ === true) return
      globalThis.__DSH_LAN_SEAT_WATCH__ = true

      const leave = () => {
        // A real navigation, not an overlay: the reloaded document contains no
        // transcript, no workspace list and no cached project data.
        window.location.assign('/')
      }

      const poll = async () => {
        for (;;) {
          try {
            const response = await fetch(`${SEAT_PATH}?wait=1`, { cache: 'no-store' })
            const state = await response.json()
            if (state && state.busy === true) {
              leave()
              return
            }
          } catch {
            // A dropped poll is not a kick; wait and ask again.
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
      void poll()
    }

    /** Palette comes from the host theme so the panel matches light and dark. */
    const styles = {
      trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 8px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsh-color-text-secondary, inherit)',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: 'rgba(0, 0, 0, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      },
      panel: {
        width: '100%',
        maxWidth: 520,
        maxHeight: '80vh',
        // A flex column with `overflow: hidden` so the title bar stays put and only
        // the body scrolls. With `overflow: auto` on the panel itself the close
        // button scrolled out of reach as soon as the instructions got long.
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 12,
        background: 'var(--dsh-color-surface, #ffffff)',
        color: 'var(--dsh-color-text-primary, #171a21)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
        border: '1px solid var(--dsh-color-border, #dfe3ea)',
        fontSize: 14,
        lineHeight: 1.6,
      },
      panelBar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 14px 8px 20px',
      },
      panelBody: {
        // `minHeight: 0` is what lets this child actually shrink and scroll inside
        // the flex column; without it the body overflows instead of scrolling.
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: '0 20px 20px',
      },
      closeButton: {
        flex: 'none',
        width: 30,
        height: 30,
        padding: 0,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--dsh-color-text-secondary, #5d6474)',
        fontSize: 20,
        lineHeight: 1,
        cursor: 'pointer',
      },
      heading: {
        margin: 0,
        fontSize: 16,
        fontWeight: 600,
      },
      primaryHint: {
        margin: '0 0 10px',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(59,123,246,.08)',
        border: '1px solid rgba(59,123,246,.28)',
        fontSize: 12.5,
        lineHeight: 1.55,
      },
      muted: {
        margin: '0 0 16px',
        color: 'var(--dsh-color-text-secondary, #5d6474)',
        fontSize: 13,
      },
      step: {
        display: 'flex',
        gap: 10,
        margin: '0 0 12px',
      },
      badge: {
        flex: '0 0 auto',
        width: 20,
        height: 20,
        borderRadius: 10,
        background: '#4c8dff',
        color: '#fff',
        fontSize: 12,
        lineHeight: '20px',
        textAlign: 'center',
        fontWeight: 600,
      },

      actions: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 18,
      },
      primary: {
        padding: '9px 16px',
        borderRadius: 8,
        border: 0,
        background: '#4c8dff',
        color: '#fff',
        fontSize: 13.5,
        fontWeight: 600,
        cursor: 'pointer',
      },
      secondary: {
        padding: '9px 16px',
        borderRadius: 8,
        border: '1px solid var(--dsh-color-border, #dfe3ea)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13.5,
        cursor: 'pointer',
      },
    }

    /** One numbered instruction row. */
    function Step({ index, children }) {
      return h('div', { style: styles.step }, [
        h('span', { key: 'n', style: styles.badge }, String(index)),
        h('div', { key: 'body', style: { flex: 1 } }, children),
      ])
    }

    /** Hosts that mean "this machine", whatever port they use. */
    const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

    /**
     * The gateway's origin as seen from wherever this page is running.
     *
     * Three very different runtimes render this panel:
     *   - the desktop shell, whose origin is the custom protocol `dsh-app://app`
     *     — NOT http, and it cannot serve the gateway's routes at all;
     *   - a desktop browser at `http://127.0.0.1:<dsh port>`, which is loopback;
     *   - a phone at `http://<lan ip>:8791`, which IS the gateway.
     *
     * So "is this the gateway?" has to be answered by scheme + port, never by
     * hostname alone: keying on the hostname turned `dsh-app://app` into a
     * download link of `dsh-app://app/__lan/app`, which nothing can open.
     *
     * @returns {string} an origin that serves the gateway's own routes.
     */
    function gatewayOrigin() {
      const here = window.location
      const scheme = here.protocol.replace(':', '').toLowerCase()
      const isHttp = scheme === 'http' || scheme === 'https'
      if (isHttp && here.port === GATEWAY_PORT && !LOOPBACK_HOSTS.has(here.hostname)) {
        return here.origin
      }
      return `http://127.0.0.1:${GATEWAY_PORT}`
    }

    /**
     * Re-read the address from the host, for the refresh button.
     *
     * The injected global is only as fresh as the last page load, so the machine
     * joining a different network makes both the code and the URL wrong. Two
     * same-origin sources, in order:
     *
     *   1. `/__lan/address` — a route this plugin registers on DSH's own server.
     *      Small and cheap, but it is an extra registration that could fail.
     *   2. Re-reading the index and parsing the injected global. Always available,
     *      because it is the very URL this page came from, and the host recomputes
     *      the value on every index render.
     *
     * @returns {Promise<object|null>} the fresh payload, or null when neither worked.
     */
    async function readAddressFromHost() {
      try {
        const response = await fetch(ADDRESS_PATH, { cache: 'no-store' })
        if (response.ok) {
          const value = await response.json()
          if (value && typeof value === 'object' && 'lan' in value) return value
        }
      } catch {
        // Fall through to the index.
      }
      try {
        const response = await fetch('/', { cache: 'no-store' })
        if (!response.ok) return null
        const html = await response.text()
        // The host renders this as `globalThis["__DSH_LAN_GATEWAY__"] = {...}`.
        const match = /globalThis\["__DSH_LAN_GATEWAY__"\]\s*=\s*(\{.*?\})<\/script>/s.exec(html)
        if (match === null) return null
        return JSON.parse(match[1])
      } catch {
        return null
      }
    }

    /**
     * Resolve the phone's download address.
     *
     * Order matters, and the first source is the important one:
     *   1. `globalThis.__DSH_LAN_GATEWAY__` — injected into the index by the Host
     *      half. Same-origin for every client, survives the desktop shell's
     *      `dsh-app://` origin, and needs no network call.
     *   2. If this page is served BY the gateway (the phone), its own origin.
     *   3. Last resort: ask the loopback status endpoint. This only works from a
     *      loopback browser page; from the desktop shell it is cross-origin and
     *      the browser blocks it, which is why it is not the primary source.
     *
     * @returns {Promise<{url: string, version: string|null}|{available: false, reason: string}>}
     */
    function resolveAppInfo() {
      const here = window.location
      const injected = globalThis.__DSH_LAN_GATEWAY__

      // The payload from the host is the same shape whether injected or fetched.
      const fromPayload = (payload) => {
        if (payload.appAvailable !== true) {
          return { available: false, reason: 'not-built' }
        }
        if (typeof payload.url === 'string' && payload.url !== '') {
          return { url: payload.url, version: null, qr: payload.qr ?? null }
        }
        return {
          url: `http://${payload.lan}:${payload.port ?? GATEWAY_PORT}${APP_PATH}`,
          version: null,
          qr: payload.qr ?? null,
        }
      }

      if (injected && typeof injected.lan === 'string' && injected.lan !== '') {
        return Promise.resolve(fromPayload(injected))
      }

      const scheme = here.protocol.replace(':', '').toLowerCase()
      const servedByGateway =
        (scheme === 'http' || scheme === 'https') &&
        here.port === GATEWAY_PORT &&
        !LOOPBACK_HOSTS.has(here.hostname)

      if (servedByGateway) {
        return Promise.resolve({ url: `${here.origin}${APP_PATH}`, version: null })
      }

      return fetch(`${gatewayOrigin()}${STATUS_PATH}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((status) => {
          const lan = (status.interfaces ?? []).find((entry) => entry.family === 'IPv4')
          if (!status.app || status.app.available !== true) {
            return { available: false, reason: 'not-built' }
          }
          if (lan === undefined) {
            return { available: false, reason: 'no-lan-interface' }
          }
          // The gateway listens on its own port, which is not the DSH port that
          // `/__lan/status` reports under `port`.
          return {
            url: `http://${lan.address}:${GATEWAY_PORT}${APP_PATH}`,
            version: status.app.version ?? null,
          }
        })
        .catch(() => ({ available: false, reason: 'unreachable' }))
    }

    /**
     * Is this page being rendered INSIDE the phone app?
     *
     * The app appends this tag to its WebView User-Agent, so the panel can stop
     * offering an app that is already installed.
     */
    function insidePhoneApp() {
      return typeof navigator !== 'undefined' && String(navigator.userAgent ?? '').includes('DSHLanApp')
    }

    /**
     * The code as an SVG.
     *
     * Fixed black-on-white and never themed: a QR code works by contrast, so it
     * must not follow the dark palette. `shapeRendering: crispEdges` keeps the
     * module edges sharp at every zoom level instead of blurring them.
     */
    function QrCode({ rows, size }) {
      const margin = 4
      const unit = 4
      const total = (size + margin * 2) * unit
      const cells = []
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          if (rows[row][column] !== '1') continue
          cells.push(
            h('rect', {
              key: `${row}-${column}`,
              x: (column + margin) * unit,
              y: (row + margin) * unit,
              width: unit,
              height: unit,
            }),
          )
        }
      }
      return h(
        'svg',
        {
          viewBox: `0 0 ${total} ${total}`,
          width: 168,
          height: 168,
          role: 'img',
          'aria-label': '下载地址二维码',
          shapeRendering: 'crispEdges',
          style: { display: 'block', flex: 'none', borderRadius: 6 },
        },
        [
          h('rect', { key: 'bg', width: '100%', height: '100%', fill: '#ffffff' }),
          h('g', { key: 'cells', fill: '#000000' }, cells),
        ],
      )
    }

    /**
     * The live pairing code, shown inline in step 2.
     *
     * The code lives for three minutes and only the computer may mint one, so it is
     * fetched when the panel opens and replaced on demand — the operator should not
     * have to leave this dialog, open the device page in another tab, press a button
     * there, and read a number back.
     */
    function PairCard({ state, busy, note, onIssue }) {
      const base = {
        margin: '0 0 4px 34px',
        padding: '12px 14px',
        border: '1px solid var(--dsh-color-border, #dfe3ea)',
        borderRadius: 10,
      }

      const digits = (code) =>
        h(
          'div',
          {
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: '0.22em',
              lineHeight: 1.1,
              marginBottom: 6,
            },
          },
          code.slice(0, 3) + ' ' + code.slice(3),
        )

      if (state === null) {
        return h(
          'div',
          { style: base },
          h('div', { style: { fontSize: 12.5, opacity: 0.7 } }, '正在读取配对码…'),
        )
      }

      const live = state.code !== null && state.code !== undefined
      return h('div', { style: base }, [
        live
          ? h('div', { key: 'code' }, [
              digits(String(state.code)),
              h(
                'div',
                { key: 'left', style: { fontSize: 12, opacity: 0.7, marginBottom: 10 } },
                state.remainingMs > 0
                  ? `剩余 ${formatRemaining(state.remainingMs)}（3 分钟内有效，只能用一次）`
                  : '已过期，请重新生成',
              ),
            ])
          : h(
              'div',
              {
                key: 'none',
                style: { fontSize: 12.5, opacity: 0.75, marginBottom: 10 },
              },
              '当前没有有效的配对码。',
            ),
        h(
          'button',
          {
            key: 'issue',
            type: 'button',
            style: { ...styles.primary, width: '100%', fontSize: 13 },
            onClick: onIssue,
            disabled: busy,
          },
          busy ? '生成中…' : live ? '换一个配对码' : '生成配对码',
        ),
        note === null
          ? null
          : h('div', { key: 'note', style: { fontSize: 11.5, marginTop: 8, opacity: 0.7 } }, note),
      ])
    }

    /** `m:ss` for a remaining duration, floored to seconds. */
    function formatRemaining(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
    }

    /** The "phone app" card at the top of the panel. */
    function AppCard({ info, onCopy, onRefresh, refreshing, refreshNote }) {
      // Inside the app itself there is nothing left to install.
      if (insidePhoneApp()) return null

      const base = {
        margin: '0 0 18px',
        padding: '14px',
        border: '1px solid var(--dsh-color-border, #dfe3ea)',
        borderRadius: 10,
      }
      if (info === null) {
        return h('div', { style: base }, h('div', { style: { fontSize: 13, opacity: 0.7 } }, '正在读取下载地址…'))
      }
      if (info.available === false) {
        return h(
          'div',
          { style: base },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '手机 APP'),
          h(
            'div',
            { style: { fontSize: 12.5, opacity: 0.75 } },
            info.reason === 'not-built'
              ? '还没有构建安装包。运行 android/build/build.ps1 之后这里会出现下载地址。'
              : '暂时读不到下载地址，请确认网关正在运行。',
          ),
        )
      }
      return h('div', { style: base }, [
        h('div', { key: 't', style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '手机 APP'),
        h(
          'div',
          { key: 'h', style: { fontSize: 12.5, opacity: 0.75, marginBottom: 12 } },
          '用手机扫描下面的二维码下载安装：',
        ),
        h('div', { key: 'row', style: { display: 'flex', gap: 16, alignItems: 'flex-start' } }, [
          h('div', { key: 'qrcol', style: { flex: 'none' } }, [
            info.qr ? h(QrCode, { key: 'qr', rows: info.qr.rows, size: info.qr.size }) : null,
            // The address changes when the machine joins a different network, so
            // the operator needs a way to re-read it without reloading the app.
            h(
              'button',
              {
                key: 'refresh',
                type: 'button',
                style: { ...styles.secondary, width: '100%', marginTop: 8, fontSize: 12 },
                onClick: onRefresh,
                disabled: refreshing,
                title: '换网络后点这里更新下载地址',
              },
              refreshing ? '刷新中…' : '刷新地址',
            ),
          ]),
          h('div', { key: 'side', style: { flex: 1, minWidth: 0 } }, [
            h(
              'div',
              {
                key: 'u',
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 12.5,
                  wordBreak: 'break-all',
                  marginBottom: 10,
                  opacity: 0.8,
                },
              },
              info.url,
              info.version ? ` · v${info.version}` : '',
            ),
            h(
              'button',
              { key: 'c', type: 'button', style: styles.secondary, onClick: onCopy },
              '复制下载链接',
            ),
            refreshNote === null
              ? null
              : h(
                  'div',
                  { key: 'n', style: { fontSize: 11.5, marginTop: 8, opacity: 0.7 } },
                  refreshNote,
                ),
          ]),
        ]),
      ])
    }

    /**
     * The remote workspace picker.
     *
     * The host's native folder chooser draws on the COMPUTER's display, so on a phone
     * the "new workspace" click popped a dialog on the wrong device and left the phone
     * waiting forever. The Host half installs a shim in the index head that makes
     * `dsh-client-ui-directory-picker-native` call
     * `globalThis.__DSH_LAN_PICK_DIRECTORY__` instead of the host RPC; this is that
     * implementation.
     *
     * Plain DOM, not React: it is opened imperatively from a promise that plugin
     * awaits, and has no render owner to hang it off.
     */
    const PICKER_STYLE_ID = 'dsh-phone-gateway-picker-style'
    const PICKER_CSS = `
      .dsh-phone-gateway-pick-scrim{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.38);
        display:flex;align-items:center;justify-content:center;padding:18px}
      .dsh-phone-gateway-pick{width:100%;max-width:520px;max-height:82vh;display:flex;flex-direction:column;
        border-radius:12px;overflow:hidden;background:var(--dsh-color-surface,#fff);
        color:var(--dsh-color-text-primary,#171a21);border:1px solid var(--dsh-color-border,#dfe3ea);
        box-shadow:0 18px 48px rgba(0,0,0,.28);font-size:14px;line-height:1.5}
      .dsh-phone-gateway-pick-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:14px 14px 8px 18px}
      .dsh-phone-gateway-pick-bar strong{font-size:15px}
      .dsh-phone-gateway-pick-x{width:30px;height:30px;border:0;border-radius:8px;background:transparent;
        color:var(--dsh-color-text-secondary,#5d6474);font-size:20px;line-height:1;cursor:pointer}
      .dsh-phone-gateway-pick-body{flex:1;min-height:0;overflow:auto;padding:0 18px 8px}
      .dsh-phone-gateway-pick-crumb{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
        opacity:.75;word-break:break-all;margin-bottom:8px;min-height:18px}
      .dsh-phone-gateway-pick-drives{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      .dsh-phone-gateway-pick-drives:empty{display:none}
      .dsh-phone-gateway-pick-drive{padding:7px 12px;border-radius:8px;font:inherit;font-size:13px;
        cursor:pointer;border:1px solid var(--dsh-color-border,#dfe3ea);background:transparent;color:inherit}
      .dsh-phone-gateway-pick-drive.active{background:#3b7bf6;border-color:#3b7bf6;color:#fff;font-weight:600}
      .dsh-phone-gateway-pick-list{border:1px solid var(--dsh-color-border,#dfe3ea);border-radius:10px;overflow:hidden}
      .dsh-phone-gateway-pick-item{display:flex;align-items:center;gap:8px;width:100%;padding:11px 12px;
        border:0;border-bottom:1px solid var(--dsh-color-border,#dfe3ea);background:transparent;
        color:inherit;font:inherit;text-align:left;cursor:pointer}
      .dsh-phone-gateway-pick-item:last-child{border-bottom:0}
      .dsh-phone-gateway-pick-item:active{background:rgba(127,127,127,.12)}
      .dsh-phone-gateway-pick-empty{padding:14px 12px;font-size:13px;opacity:.7}
      .dsh-phone-gateway-pick-new{display:flex;gap:8px;margin:12px 0}
      .dsh-phone-gateway-pick-new input{flex:1;min-width:0;padding:10px;border-radius:9px;font:inherit;
        border:1px solid var(--dsh-color-border,#dfe3ea);background:transparent;color:inherit}
      .dsh-phone-gateway-pick-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 18px 16px}
      .dsh-phone-gateway-pick-btn{padding:10px 16px;border-radius:9px;font:inherit;cursor:pointer;
        border:1px solid var(--dsh-color-border,#dfe3ea);background:transparent;color:inherit}
      .dsh-phone-gateway-pick-btn.primary{background:#3b7bf6;border-color:#3b7bf6;color:#fff;font-weight:600}
      .dsh-phone-gateway-pick-btn:disabled{opacity:.5;cursor:default}
      .dsh-phone-gateway-pick-note{padding:0 18px 8px;font-size:12px;opacity:.7;min-height:16px}
    `

    /** Mount the picker; resolve with the chosen absolute path, or null on cancel. */
    function openWorkspacePicker(done) {
      if (typeof document === 'undefined' || document.body === null) {
        done(null)
        return
      }
      if (document.getElementById(PICKER_STYLE_ID) === null) {
        const style = document.createElement('style')
        style.id = PICKER_STYLE_ID
        style.textContent = PICKER_CSS
        document.head.appendChild(style)
      }

      // `absolute` is the only value handed back; it always comes from the host.
      const state = { root: 0, path: '', absolute: undefined }
      let settled = false

      const scrim = document.createElement('div')
      scrim.className = 'dsh-phone-gateway-pick-scrim'
      const dialog = document.createElement('div')
      dialog.className = 'dsh-phone-gateway-pick'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', '选择工作区目录')
      scrim.appendChild(dialog)

      const bar = document.createElement('div')
      bar.className = 'dsh-phone-gateway-pick-bar'
      const title = document.createElement('strong')
      title.textContent = '选择工作区目录'
      const closeX = document.createElement('button')
      closeX.type = 'button'
      closeX.className = 'dsh-phone-gateway-pick-x'
      closeX.setAttribute('aria-label', '取消')
      closeX.textContent = '\u00d7'
      bar.append(title, closeX)
      dialog.appendChild(bar)

      const body = document.createElement('div')
      body.className = 'dsh-phone-gateway-pick-body'
      dialog.appendChild(body)

      const crumb = document.createElement('div')
      crumb.className = 'dsh-phone-gateway-pick-crumb'
      body.appendChild(crumb)

      // Drive / root switcher. The native dialog can jump between volumes; without
      // this the picker is stuck on whatever root it opened with.
      const driveRow = document.createElement('div')
      driveRow.className = 'dsh-phone-gateway-pick-drives'
      body.appendChild(driveRow)

      const list = document.createElement('div')
      list.className = 'dsh-phone-gateway-pick-list'
      body.appendChild(list)

      const newRow = document.createElement('div')
      newRow.className = 'dsh-phone-gateway-pick-new'
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.placeholder = '新建文件夹名'
      const createButton = document.createElement('button')
      createButton.type = 'button'
      createButton.className = 'dsh-phone-gateway-pick-btn'
      createButton.textContent = '新建'
      newRow.append(nameInput, createButton)
      body.appendChild(newRow)

      const note = document.createElement('div')
      note.className = 'dsh-phone-gateway-pick-note'
      dialog.appendChild(note)

      const foot = document.createElement('div')
      foot.className = 'dsh-phone-gateway-pick-foot'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dsh-phone-gateway-pick-btn'
      cancel.textContent = '取消'
      const choose = document.createElement('button')
      choose.type = 'button'
      choose.className = 'dsh-phone-gateway-pick-btn primary'
      choose.textContent = '选择此目录'
      foot.append(cancel, choose)
      dialog.appendChild(foot)

      const finish = (value) => {
        if (settled) return
        settled = true
        window.removeEventListener('keydown', onKey, true)
        scrim.remove()
        done(value)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          finish(null)
        }
      }
      closeX.addEventListener('click', () => finish(null))
      cancel.addEventListener('click', () => finish(null))
      scrim.addEventListener('mousedown', (event) => {
        if (event.target === scrim) finish(null)
      })
      window.addEventListener('keydown', onKey, true)

      const load = (root, path) => {
        state.root = root
        note.textContent = '读取中…'
        fetch(`${DIRS_PATH}?root=${String(root)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => render(payload))
          .catch(() => {
            note.textContent = '读取失败，请重试。'
          })
      }

      function render(payload) {
        state.absolute = typeof payload.absolute === 'string' ? payload.absolute : undefined
        state.path = typeof payload.relative === 'string' ? payload.relative : ''
        note.textContent = ''
        crumb.textContent = payload.empty === true ? '' : `/${state.path}`
        list.replaceChildren()
        driveRow.replaceChildren()

        const roots = Array.isArray(payload.roots) ? payload.roots : []
        // Root buttons: one per drive. The native dialog can jump volumes; without
        // these the picker is stuck on whichever root it opened with.
        if (roots.length > 1) {
          for (const root of roots) {
            const chip = document.createElement('button')
            chip.type = 'button'
            chip.className = 'dsh-phone-gateway-pick-drive'
            chip.textContent = root.label
            if (root.index === state.root) chip.classList.add('active')
            chip.addEventListener('click', () => load(root.index, ''))
            driveRow.appendChild(chip)
          }
        }

        if (payload.empty === true) {
          const empty = document.createElement('div')
          empty.className = 'dsh-phone-gateway-pick-empty'
          empty.textContent = '这台电脑上没有可访问的磁盘。'
          list.appendChild(empty)
          choose.disabled = true
          createButton.disabled = true
          return
        }

        choose.disabled = payload.ok !== true
        createButton.disabled = payload.ok !== true

        if (payload.ok !== true) {
          const failed = document.createElement('div')
          failed.className = 'dsh-phone-gateway-pick-empty'
          // Explain the refusal in terms the operator can act on.
          failed.textContent =
            payload.error === 'unreadable'
              ? '这个目录没有访问权限（系统保留目录），请返回上一级。'
              : '读不到这个目录，请返回上一级再试。'
          list.appendChild(failed)
          return
        }

        // Parent entry, except at the root itself.
        if (state.path !== '') {
          const up = document.createElement('button')
          up.type = 'button'
          up.className = 'dsh-phone-gateway-pick-item'
          up.textContent = '.. 上一级'
          up.addEventListener('click', () => {
            const parts = state.path.split('/').filter(Boolean)
            parts.pop()
            load(state.root, parts.join('/'))
          })
          list.appendChild(up)
        }

        const entries = Array.isArray(payload.entries) ? payload.entries : []
        for (const entry of entries) {
          const item = document.createElement('button')
          item.type = 'button'
          item.className = 'dsh-phone-gateway-pick-item'
          item.textContent = `\u{1F4C1} ${entry.name}`
          item.addEventListener('click', () => load(state.root, entry.path))
          list.appendChild(item)
        }

        if (entries.length === 0 && state.path !== '') {
          const empty = document.createElement('div')
          empty.className = 'dsh-phone-gateway-pick-empty'
          empty.textContent = '这个目录下没有子目录，可以直接选择它。'
          list.appendChild(empty)
        }
      }

      createButton.addEventListener('click', () => {
        const name = nameInput.value.trim()
        if (name === '') return
        createButton.disabled = true
        fetch(DIRS_PATH, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: state.root, path: state.path, name }),
        })
          .then((response) => response.json())
          .then((result) => {
            createButton.disabled = false
            if (result.ok !== true) {
              note.textContent =
                result.error === 'exists' ? '同名文件夹已存在。' : '新建失败，请换一个名字（不能包含 \\ / : 等字符）。'
              return
            }
            nameInput.value = ''
            load(state.root, state.path)
          })
          .catch(() => {
            createButton.disabled = false
            note.textContent = '新建失败，请重试。'
          })
      })

      choose.addEventListener('click', () => {
        if (state.absolute === undefined) return
        finish(state.absolute)
      })

      document.body.appendChild(scrim)
      load(0, '')
    }

    /**
     * Publish the picker for the head shim to call.
     *
     * Installed on every origin: the shim only exists on LAN pages, so on the desktop
     * this is simply never reached.
     */
    function installWorkspacePickerBridge() {
      if (typeof globalThis === 'undefined') return
      if (typeof globalThis.__DSH_LAN_PICK_DIRECTORY__ === 'function') return
      globalThis.__DSH_LAN_PICK_DIRECTORY__ = (done) => {
        openWorkspacePicker(done)
      }
    }

    /**
     * The sidebar-foot button plus the panel it opens.
     *
     * The owner passes `wide`: false means a 56px rail, where only the icon
     * fits. Collapsing to the icon keeps the entry usable in both states
     * instead of clipping its label.
     */
    function LanGatewayAction({ wide = true }) {
      const [open, setOpen] = React.useState(false)
      const [appInfo, setAppInfo] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [refreshNote, setRefreshNote] = React.useState(null)
      // `null` = still loading; `{ code: null }` = loaded, nothing active.
      const [pairCode, setPairCode] = React.useState(null)
      const [pairBusy, setPairBusy] = React.useState(false)
      const [pairNote, setPairNote] = React.useState(null)
      // Re-renders once a second so the countdown ticks without refetching.
      const [, setTick] = React.useState(0)

      // Escape closes the panel, matching the rest of the shell.
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // The address is resolved on open, not at mount: the operator may have
      // switched networks since the page loaded.
      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        resolveAppInfo().then((info) => {
          if (!cancelled) setAppInfo(info)
        })
        return () => {
          cancelled = true
        }
      }, [open])

      // Read the live pairing code when the panel opens. GET is idempotent, so
      // opening the dialog never invalidates a code the operator already read out.
      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        fetch(PAIRCARD_PATH, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : { code: null }))
          .then((value) => {
            if (!cancelled) {
              setPairCode({ code: value.code ?? null, expiresAt: value.expiresAt ?? null })
            }
          })
          .catch(() => {
            if (!cancelled) setPairCode({ code: null, expiresAt: null, failed: true })
          })
        return () => {
          cancelled = true
        }
      }, [open])

      // Tick the countdown once a second while the panel is open. Cheap, and it
      // keeps the "remaining" line honest without polling the host.
      React.useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [open])

      const copyAppUrl = () => {
        if (appInfo === null || appInfo.url === undefined) return
        navigator.clipboard?.writeText(appInfo.url).catch(() => undefined)
      }

      /**
       * The pairing code with its remaining lifetime recomputed for this render.
       *
       * The host hands back an absolute `expiresAt`; keeping the subtraction here
       * means the countdown needs no extra round trip.
       */
      const pairCodeView =
        pairCode === null
          ? null
          : {
              code: pairCode.code ?? null,
              remainingMs:
                typeof pairCode.expiresAt === 'number'
                  ? Math.max(0, pairCode.expiresAt - Date.now())
                  : 0,
            }

      /**
       * Mint a new pairing code.
       *
       * Only the computer may do this, so it goes through the host route rather
       * than the phone-facing page. The previous code stops working immediately.
       */
      const issuePairCode = async () => {
        setPairBusy(true)
        setPairNote(null)
        try {
          const response = await fetch(PAIRCARD_PATH, { method: 'POST', cache: 'no-store' })
          if (!response.ok) throw new Error(`status ${String(response.status)}`)
          const value = await response.json()
          setPairCode({ code: value.code ?? null, expiresAt: value.expiresAt ?? null })
          setPairNote('已生成新的配对码，旧码已失效。')
        } catch {
          setPairNote('生成失败，请重试。')
        } finally {
          setPairBusy(false)
        }
      }

      /**
       * Re-read the address from the host.
       *
       * Needed because the machine can join a different network while the page
       * stays open: the injected payload then names an address the phone can no
       * longer reach, and the code points at it too. It also picks up an installer
       * that was built after the page loaded.
       */
      const refreshAddress = async () => {
        setRefreshing(true)
        setRefreshNote(null)
        const payload = await readAddressFromHost()
        if (payload === null) {
          setRefreshing(false)
          setRefreshNote('刷新失败：读不到地址，请重新加载页面。')
          return
        }
        const previous = appInfo !== null && appInfo.available !== false ? appInfo.url : null
        const next = payload.appAvailable === true
          ? {
              url: typeof payload.url === 'string' && payload.url !== ''
                ? payload.url
                : `http://${payload.lan}:${payload.port ?? GATEWAY_PORT}${APP_PATH}`,
              version: null,
              qr: payload.qr ?? null,
            }
          : { available: false, reason: 'not-built' }
        setAppInfo(next)
        setRefreshing(false)
        setRefreshNote(
          next.available === false
            ? '已刷新：当前没有安装包。'
            : next.url === previous
              ? '已刷新：地址没有变化。'
              : '已刷新：地址已更新。',
        )
      }

      const trigger = h(
        'button',
        {
          type: 'button',
          style: {
            ...styles.trigger,
            justifyContent: wide ? 'flex-start' : 'center',
            padding: wide ? styles.trigger.padding : '6px',
          },
          title: '局域网网关 — 让手机访问这台电脑上的 DSH',
          'aria-label': '局域网网关',
          onClick: () => setOpen(true),
        },
        [
          h(
            'svg',
            {
              key: 'icon',
              viewBox: '0 0 24 24',
              width: 16,
              height: 16,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              style: { flex: '0 0 auto' },
            },
            [
              h('rect', { key: 'a', x: 2, y: 4, width: 13, height: 9, rx: 1.5 }),
              h('path', { key: 'b', d: 'M6 17h6' }),
              h('rect', { key: 'c', x: 15.5, y: 11, width: 6, height: 10, rx: 1.5 }),
            ],
          ),
          wide ? h('span', { key: 'label' }, '局域网网关') : null,
        ],
      )

      if (!open) return trigger

      const closeOnBackdrop = (event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }

      return h(React.Fragment, null, [
        trigger,
        h(
          'div',
          { key: 'overlay', style: styles.overlay, onMouseDown: closeOnBackdrop },
          h('div', { style: styles.panel, role: 'dialog', 'aria-modal': 'true' }, [
            // Pinned title bar: the close control has to be reachable at any scroll
            // position, so it lives outside the scrolling body.
            h('div', { key: 'bar', style: styles.panelBar }, [
              h('h2', { key: 'title', style: styles.heading }, '局域网网关'),
              h(
                'button',
                {
                  key: 'close',
                  type: 'button',
                  style: styles.closeButton,
                  'aria-label': '关闭',
                  title: '关闭（Esc）',
                  onClick: () => setOpen(false),
                },
                '\u00d7',
              ),
            ]),
            h('div', { key: 'body', style: styles.panelBody }, [
              // First line, before anything else: the control-slot rule is the one
              // thing an operator needs to know before pairing a second phone.
              h(
                'p',
                { key: 'primary-hint', style: styles.primaryHint },
                '只有一台手机能控制 DSH。默认第一台连接（配对）的手机是主控制设备，'
                  + '它随时可以连接；主控在线时其它手机连不上，主控离线时其它手机之间也只允许一台。'
                  + '主控可在配置页更改。',
              ),
              h('div', { key: 'primary-actions', style: styles.actions }, [
                h(
                  'button',
                  {
                    key: 'open',
                    type: 'button',
                    style: styles.primary,
                    onClick: () => window.open(`${gatewayOrigin()}${DEVICES_PATH}`, '_blank', 'noopener,noreferrer'),
                  },
                  '打开配置页',
                ),
                h(
                  'button',
                  {
                    key: 'status',
                    type: 'button',
                    style: styles.secondary,
                    onClick: () => window.open(`${gatewayOrigin()}${STATUS_PATH}`, '_blank', 'noopener,noreferrer'),
                  },
                  '查看网关状态',
                ),
              ]),

              h(
                'p',
                { key: 'sub', style: styles.muted },
                '让手机通过同一个 Wi-Fi 或热点访问这台电脑上正在运行的 DSH。手机与电脑共用同一个进程，不需要另开实例。',
              ),

              h(AppCard, {
                key: 'app',
                info: appInfo,
                onCopy: copyAppUrl,
                onRefresh: refreshAddress,
                refreshing,
                refreshNote,
              }),

              h(
                Step,
                { key: 's1', index: 1 },
                '用手机浏览器打开上面的下载地址，安装 Android APP。',
              ),
              h(
                Step,
                { key: 's2', index: 2 },
                '在 APP 里输入下面这 6 位配对码：',
              ),
              h(PairCard, {
                key: 'paircard',
                // Recomputed each render; the one-second tick keeps it live.
                state: pairCodeView,
                busy: pairBusy,
                note: pairNote,
                onIssue: issuePairCode,
              }),
              h(
                Step,
                { key: 's3', index: 3 },
                '手机打开 DSH APP —— 它会自动找到这台电脑，不用输网址。',
              ),
              h(Step, { key: 's4', index: 4 }, '配对后 180 天内打开即用，不需要每次重新配对。'),

              h(
                'p',
                { key: 'note', style: { ...styles.muted, marginTop: 12 } },
                '换网络后地址会变，但 APP 会自动重新发现，不需要重新配对。',
              ),

              // The action row lives directly under the first-line hint now, so
              // nothing is pinned to the bottom of a scrolling panel.
            ]),
          ]),
        ),
      ])
    }

    /**
     * The registered slot entry.
     *
     * Split from `LanGatewayAction` so the "already inside the app" check can bail
     * out BEFORE any hook runs. A conditional `return` placed between hooks would
     * violate the rules of hooks; a wrapper with no hooks is safe.
     */
    function LanGatewayEntry(props) {
      if (insidePhoneApp()) return null
      return h(LanGatewayAction, props)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The picker has nothing to do with the sidebar entry: install it before
        // the "inside the phone app" bail-out, or the phone — the only client that
        // needs it — would never get one.
        installWorkspacePickerBridge()
        // Same for the seat watcher: it must run inside the app too, otherwise an
        // evicted phone would keep showing whatever it had already loaded.
        startSeatWatcher()
        // Everything the sidebar entry offers — download the app, pair a phone, check
        // the gateway — is meaningless once you are already inside the app. Registering
        // there would leave a dead button in the footer, so it is skipped outright.
        if (insidePhoneApp()) return
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'lan-gateway-entry', order: 10 },
            LanGatewayEntry,
          ),
        )
      },
    }
  },
})
