/**
 * The two HTML pages the gateway serves itself:
 *
 *  - `/__lan/pair`  on a phone: asks for the 6-digit code.
 *  - `/__lan/devices` on the computer: shows and revokes paired devices and
 *                   offers a button that issues a code.
 *
 * Both pages are intentionally plain: no build step, no external assets, no
 * theme tokens (the gateway is not part of the Harness UI bundle), because a
 * phone that just joined the hotspot may have nothing else reachable.
 *
 * Every URL in these pages is ABSOLUTE. The pair page is served at `/` while a
 * device is unpaired, so a relative `fetch('pair')` would resolve against the
 * root and miss `/__lan/...` entirely.
 */

import { DEVICE_LABEL_MAX } from './pair.js'
import { qrSvgMarkup } from './qr.js'

/** Copy for both languages; the gateway is used on Chinese-locale machines a lot. */
const TEXT = {
  zh: {
    pairTitle: '配对这个设备',
    pairHeading: '配对这个设备',
    pairHint: '请输入电脑上显示的 6 位配对码。',
    pairPlaceholder: '000000',
    pairSubmit: '配对',
    pairSuccess: '配对成功，正在进入…',
    pairBadCode: '配对码不正确。',
    pairTooMany: '尝试次数过多，请在电脑上重新获取配对码。',
    pairNoCode: '当前没有有效的配对码，请在电脑上生成一个。',
    pairFailed: '配对失败。',
    pairUnreachable: '无法连接到网关。',
    appTitle: '还没装手机 APP？',
    appHint: '装好 APP 后，它会自动找到这台电脑，不用再记地址。',
    appDownload: '下载 Android APP',
    devicesAppTitle: '手机 APP',
    devicesAppHint: '在手机浏览器里打开下面的地址即可下载安装。',
    devicesAppCopy: '复制下载链接',
    devicesAppCopied: '已复制',
    devicesAppMissing: '还没有构建安装包：运行 android/build/build.ps1 后这里会出现下载链接。',
    devicesTitle: '局域网网关设备',
    devicesHeading: '局域网网关设备',
    devicesHint: '已配对到这台电脑的 Harness 的设备。',
    devicesNoCode: '当前没有有效的配对码。',
    devicesCode: '配对码',
    devicesExpires: '剩余',
    devicesSeconds: '秒',
    devicesShowCode: '显示配对码',
    devicesNewCode: '换一个配对码',
    devicesColDevice: '设备',
    devicesColPaired: '配对时间',
    devicesColExpires: '有效期至',
    devicesColAction: '',
    devicesNone: '还没有已配对的设备。',
    devicesRevoke: '吊销',
    devicesPrimary: '主控制设备',
    devicesInUse: '使用中',
    devicesMakePrimary: '设为主设备',
    busyTitle: '设备正在使用中',
    busyHint: '另一台手机正在使用这台电脑上的 DSH。只有一台设备能同时使用，主控制设备随时可以接管。等对方断开后，这个页面会自动重试。',
    busyRetry: '立即重试',
    busyCountdown: '{n} 秒后自动重试',
  },
  en: {
    pairTitle: 'Pair this device',
    pairHeading: 'Pair this device',
    pairHint: 'Enter the 6-digit code shown on the computer running Harness.',
    pairPlaceholder: '000000',
    pairSubmit: 'Pair',
    pairSuccess: 'Paired. Opening…',
    pairBadCode: 'That code is not correct.',
    pairTooMany: 'Too many attempts. Ask the computer for a new code.',
    pairNoCode: 'No code is active. Ask the computer to show one.',
    pairFailed: 'Pairing failed.',
    pairUnreachable: 'Could not reach the gateway.',
    appTitle: 'No phone app yet?',
    appHint: 'Once installed, the app finds this computer by itself — no address to remember.',
    appDownload: 'Download the Android app',
    devicesAppTitle: 'Phone app',
    devicesAppHint: 'Open this address in the phone browser to download and install it.',
    devicesAppCopy: 'Copy download link',
    devicesAppCopied: 'Copied',
    devicesAppMissing: 'No installer has been built yet. Run android/build/build.ps1 and the link appears here.',
    devicesTitle: 'Phone gateway devices',
    devicesHeading: 'Phone gateway devices',
    devicesHint: "Devices paired to this computer's Harness.",
    devicesNoCode: 'No active pairing code.',
    devicesCode: 'Pairing code',
    devicesExpires: 'expires in',
    devicesSeconds: 's',
    devicesShowCode: 'Show a pairing code',
    devicesNewCode: 'Show a new code',
    devicesColDevice: 'Device',
    devicesColPaired: 'Paired',
    devicesColExpires: 'Expires',
    devicesColAction: '',
    devicesNone: 'No paired devices yet.',
    devicesRevoke: 'Revoke',
    devicesPrimary: 'Primary',
    devicesInUse: 'In use',
    devicesMakePrimary: 'Make primary',
    busyTitle: 'Another device is in use',
    busyHint: 'Another phone is driving DSH on this computer. Only one device can be connected at a time, and the primary device may take over at any moment. This page retries by itself once that device disconnects.',
    busyRetry: 'Retry now',
    busyCountdown: 'Retrying in {n}s',
  },
}

/**
 * Pick a language from `Accept-Language`, defaulting to Chinese because the
 * operator facing these pages is the machine's own user. Both browsers arrive
 * here with a well-formed header, so a missing one is not worth detecting.
 */
export function pickLanguage(acceptLanguage) {
  if (typeof acceptLanguage !== 'string' || acceptLanguage === '') return 'zh'
  const first = acceptLanguage.split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('en') ? 'en' : 'zh'
}

/** Shared shell so both pages look like one product. */
function page({ title, lang, body }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --fg:#e6e8ee; --muted:#8b93a7; --line:#252a36; --accent:#4c8dff; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --fg:#171a21; --muted:#5d6474; --line:#dfe3ea; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg); padding:24px;
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { width:100%; max-width:560px; }
  h1 { font-size:20px; margin:0 0 4px; font-weight:600; }
  p { margin:0 0 20px; color:var(--muted); }
  input[type=text] { width:100%; padding:16px; font-size:28px; letter-spacing:.35em; text-align:center;
         border-radius:12px; border:1px solid var(--line); background:transparent; color:var(--fg);
         font-variant-numeric:tabular-nums; }
  button { margin-top:16px; width:100%; padding:14px; font-size:16px; border:0; border-radius:12px;
           background:var(--accent); color:#fff; cursor:pointer; font-family:inherit; }
  button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line);
                     margin:0; padding:8px 12px; width:auto; font-size:13px; }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:#ff6b6b; min-height:24px; margin-top:12px; }
  code { background:var(--line); padding:2px 8px; border-radius:6px; font-size:15px;
         letter-spacing:.2em; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; font-size:14px; margin-top:8px; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  .muted { color:var(--muted); font-size:13px; }
  .app-card { margin-top:28px; padding:16px; border:1px solid var(--line); border-radius:12px; }
  .app-title { font-size:15px; font-weight:600; margin-bottom:4px; }
  .app-hint { color:var(--muted); font-size:13px; margin-bottom:12px; }
  .app-button { display:block; text-align:center; padding:14px; border-radius:10px;
                background:var(--accent); color:#fff; font-size:15px; font-weight:600;
                text-decoration:none; }
  .app-meta { color:var(--muted); font-size:11.5px; margin-top:8px; word-break:break-all; }
  .app-row { display:flex; gap:16px; align-items:flex-start; }
  .app-side { flex:1; min-width:0; }
  .qr { flex:none; line-height:0; }
  .qr svg { width:150px; height:150px; display:block; border-radius:6px; }
  @media (max-width: 420px) { .app-row { flex-direction:column; } }
  /* A flexbox <td> stops taking part in table layout, which is what let the role
     badge and the dates overlap. Keep the cell a cell and lay its buttons out inline. */
  td.actions { white-space:nowrap; text-align:right; width:1%; }
  td.actions > * { vertical-align:middle; }
  td.actions > * + * { margin-left:6px; }
  td.label { max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.stamp { white-space:nowrap; color:var(--muted); font-variant-numeric:tabular-nums; }
  tr.is-primary td { background:rgba(59,123,246,.07); }
  .role { font-size:12px; font-weight:600; color:#3b7bf6; padding:2px 8px; border:1px solid #3b7bf6; border-radius:999px;
          white-space:nowrap; display:inline-block; }
  .role.in-use { color:#17934a; border-color:#17934a; background:rgba(23,147,74,.08); }
  td.actions button { white-space:nowrap; }
  .copy { margin-top:10px; width:100%; padding:10px; font-size:13px; font-family:inherit;
          border:1px solid var(--line); border-radius:10px; background:transparent;
          color:var(--fg); cursor:pointer; }
</style>
</head>
<body><main>${body}</main></body>
</html>
`
}

/** JSON for a JS string literal inside a <script> block. */
function js(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * The code entry page a phone lands on while it is not paired yet.
 *
 * `appUrl` is the installer link for this very host — offered BEFORE pairing,
 * because the app keeps its own cookie jar and would otherwise have to pair a
 * second time just to be installed. It is null when no build exists, so the
 * page never shows a dead button.
 *
 * @param {'zh'|'en'} [lang] - page language.
 * @param {string|null} [appUrl] - absolute download URL, or null.
 * @param {{version?: string|null, size?: number|null}|null} [app] - build facts.
 * @param {boolean} [hideDownload] - true when the request came from the app itself,
 * where offering the installer again is noise.
 */
export function pairPage(lang = 'zh', appUrl = null, app = null, hideDownload = false) {
  const t = TEXT[lang] ?? TEXT.zh
  const appSection = appUrl === null || hideDownload
    ? ''
    : `
      <div class="app-card">
        <div class="app-title">${t.appTitle}</div>
        <div class="app-hint">${t.appHint}</div>
        <a class="app-button" href="${escapeHtml(appUrl)}">${t.appDownload}</a>
        <div class="app-meta">${escapeHtml(appUrl)}${
          app?.version ? ` · v${escapeHtml(String(app.version))}` : ''
        }</div>
      </div>`
  return page({
    title: t.pairTitle,
    lang,
    body: `
      <h1>${t.pairHeading}</h1>
      <p>${t.pairHint}</p>
      <form id="pair" autocomplete="off">
        <input id="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
               placeholder="${t.pairPlaceholder}" required autofocus>
        <button id="go" type="submit">${t.pairSubmit}</button>
      </form>
      <div class="err" id="err"></div>
      ${appSection}
      <script>
        const strings = ${js({
          bad: t.pairBadCode,
          tooMany: t.pairTooMany,
          noCode: t.pairNoCode,
          failed: t.pairFailed,
          unreachable: t.pairUnreachable,
          success: t.pairSuccess,
        })}
        const form = document.getElementById('pair')
        const input = document.getElementById('code')
        const err = document.getElementById('err')
        const go = document.getElementById('go')
        input.addEventListener('input', () => { input.value = input.value.replace(/\\D/g, '').slice(0, 6) })
        form.addEventListener('submit', async (event) => {
          event.preventDefault()
          err.textContent = ''
          go.disabled = true
          try {
            // Absolute: this page is also served at '/', where a relative URL
            // would resolve against the root instead of /__lan/pair.
            const res = await fetch('/__lan/pair', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: input.value, label: navigator.userAgent.slice(0, ${String(DEVICE_LABEL_MAX)}) }),
            })
            const data = await res.json().catch(() => ({}))
            if (res.ok && data.ok) { err.textContent = strings.success; location.href = '/'; return }
            err.textContent = ({
              'bad-code': strings.bad,
              'too-many-attempts': strings.tooMany,
              'no-active-code': strings.noCode,
            })[data.error] ?? strings.failed
          } catch (e) {
            err.textContent = strings.unreachable
          } finally {
            go.disabled = false
          }
        })
      </script>`,
  })
}

/**
 * The page a phone sees when another device is driving the session.
 *
 * A kicked phone lands here on its very next request, so the page has to be useful
 * on its own: it names the situation and retries by itself, because the operator is
 * not going to sit and press reload waiting for the other phone to finish.
 *
 * @param {'zh'|'en'} [lang] - page language.
 * @param {number} [retryMs] - how often to retry automatically.
 */
export function busyPage(lang = 'zh', retryMs = 8000) {
  const t = TEXT[lang] ?? TEXT.zh
  return page({
    title: t.busyTitle,
    lang,
    body: `
      <h1>${t.busyTitle}</h1>
      <p>${t.busyHint}</p>
      <button id="retry">${t.busyRetry}</button>
      <p class="muted" id="countdown"></p>
      <script>
        const seconds = ${js(Math.max(1, Math.round(retryMs / 1000)))}
        const label = document.getElementById('countdown')
        const button = document.getElementById('retry')
        let left = seconds
        const tick = () => {
          label.textContent = ${js(t.busyCountdown)}.replace('{n}', String(left))
          if (left <= 0) {
            location.reload()
            return
          }
          left -= 1
          setTimeout(tick, 1000)
        }
        button.addEventListener('click', () => location.reload())
        tick()
      </script>`,
  })
}

/**
 * The operator's device page, served on the computer only.
 *
 * `appUrl` is the LAN download link for the phone app, or null when no build
 * exists — the computer cannot use a loopback link for this, so the address is
 * resolved from the machine's own interfaces by the caller.
 *
 * @param {object[]} devices - paired devices.
 * @param {object|null} activeCode - the live pairing code, or null.
 * @param {'zh'|'en'} [lang] - page language.
 * @param {string|null} [appUrl] - absolute LAN download URL, or null.
 * @param {{version?: string|null, size?: number|null}|null} [app] - build facts.
 * @param {string[]|null} [qrRows] - QR matrix rows for the download address, or null.
 * @param {string|null} [primaryId] - the device holding the control slot, or null.
 */
export function devicesPage(
  devices,
  activeCode,
  lang = 'zh',
  appUrl = null,
  app = null,
  qrRows = null,
  primaryId = null,
  holderId = null,
) {
  const t = TEXT[lang] ?? TEXT.zh
  // Rendered server-side, so the timestamps use THIS computer's clock — the one the
  // operator is looking at. Minutes matter: two pairings can be a minute apart and
  // they used to read as the same day.
  const stamp = (ms) => {
    const at = new Date(Number(ms))
    const pad = (value) => String(value).padStart(2, '0')
    return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  const rows = devices
    .map(
      (device) => {
        const isPrimary = device.id === primaryId
        // The role is one seat: the button only appears on the others.
        const role = isPrimary
          ? `<span class="role">${t.devicesPrimary}</span>`
          : `<button class="secondary" data-primary="${escapeHtml(device.id)}">${t.devicesMakePrimary}</button>`
        // Which device is driving the session right now; the rest of the row can
        // look identical, so this is the only way to see who is actually connected.
        const inUse = device.id === holderId ? `<span class="role in-use">${t.devicesInUse}</span>` : ''
        // The UA is long and repeats; the full text stays available as a tooltip.
        return `<tr${isPrimary ? ' class="is-primary"' : ''}>
        <td class="label" title="${escapeHtml(device.label)}">${escapeHtml(device.label)}</td>
        <td class="stamp">${stamp(device.issuedAt)}</td>
        <td class="stamp">${stamp(device.expiresAt)}</td>
        <td class="actions">${inUse}${role}<button class="secondary" data-id="${escapeHtml(device.id)}">${t.devicesRevoke}</button></td>
      </tr>`
      },
    )
    .join('')

  const codeBlock =
    activeCode === null
      ? `<p>${t.devicesNoCode}</p>`
      : `<p>${t.devicesCode}: <code id="livecode">${escapeHtml(activeCode.code)}</code>
         ${t.devicesExpires} <span id="left">${Math.max(
           0,
           Math.round((activeCode.expiresAt - Date.now()) / 1000),
         )}</span>${t.devicesSeconds}</p>`

  const appBlock =
    appUrl === null
      ? `<div class="app-card"><div class="app-title">${t.devicesAppTitle}</div>
           <div class="app-hint">${t.devicesAppMissing}</div></div>`
      : `<div class="app-card">
           <div class="app-title">${t.devicesAppTitle}</div>
           <div class="app-hint">${t.devicesAppHint}</div>
           <div class="app-row">
             ${qrRows === null ? '' : `<div class="qr">${qrSvgMarkup(qrRows, { label: appUrl })}</div>`}
             <div class="app-side">
               <div class="app-meta">${escapeHtml(appUrl)}${
                 app?.size ? ` · ${Math.round(app.size / 1024)} KB` : ''
               }${app?.version ? ` · v${escapeHtml(String(app.version))}` : ''}</div>
               <button class="copy" id="copyapp">${t.devicesAppCopy}</button>
             </div>
           </div>
         </div>`

  return page({
    title: t.devicesTitle,
    lang,
    body: `
      <h1>${t.devicesHeading}</h1>
      <p>${t.devicesHint}</p>
      ${codeBlock}
      <button id="newcode">${activeCode === null ? t.devicesShowCode : t.devicesNewCode}</button>
      ${appBlock}
      <table><thead>
        <tr><th>${t.devicesColDevice}</th><th>${t.devicesColPaired}</th><th>${t.devicesColExpires}</th><th class="actions"></th></tr>
      </thead><tbody>${rows === '' ? `<tr><td colspan="4">${t.devicesNone}</td></tr>` : rows}</tbody></table>
      <script>
        const copyapp = document.getElementById('copyapp')
        if (copyapp) {
          copyapp.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(${js(appUrl ?? '')})
              copyapp.textContent = ${js(t.devicesAppCopied)}
            } catch (e) {
              // Clipboard needs a secure context; fall back to selecting the text.
              copyapp.textContent = ${js(appUrl ?? '')}
            }
          })
        }
        const left = document.getElementById('left')
        if (left) {
          const started = Date.now()
          const from = Number(left.textContent)
          setInterval(() => {
            const now = Math.max(0, from - Math.round((Date.now() - started) / 1000))
            left.textContent = String(now)
            if (now === 0) location.reload()
          }, 1000)
        }
        document.getElementById('newcode').addEventListener('click', async () => {
          // Absolute: served at /__lan/devices, so 'code' alone would resolve
          // to /__lan/code — correct — but '__lan/code' would double the prefix.
          await fetch('/__lan/code', { method: 'POST' })
          location.reload()
        })
        for (const button of document.querySelectorAll('button[data-id]')) {
          button.addEventListener('click', async () => {
            await fetch('/__lan/devices', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revoke: button.dataset.id }),
            })
            location.reload()
          })
        }
        // Moving the control slot to another phone. Reloading keeps the table and
        // the role badge consistent with what the store now says.
        for (const button of document.querySelectorAll('button[data-primary]')) {
          button.addEventListener('click', async () => {
            await fetch('/__lan/devices', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ setPrimary: button.dataset.primary }),
            })
            location.reload()
          })
        }
      </script>`,
  })
}

/** Minimal HTML escape for the values interpolated above. */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
