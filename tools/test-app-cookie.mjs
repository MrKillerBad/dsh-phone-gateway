/**
 * The app's device-credential persistence.
 *
 * A browser cookie is scoped to its HOST, and the machine's LAN address changes
 * with every network. So the phone pairs against one address, later discovers
 * another, and the WebView correctly refuses to send the old cookie — the gateway
 * then asks for a code again even though the pairing is still valid.
 *
 * The credential is not host-bound on the server (the signature covers only
 * `deviceId.expiresAt`), so the app stores it and replays it against whatever
 * address discovery returns. These assertions pin that wiring, which cannot be
 * exercised without a device.
 *
 * Run:  node tools/test-app-cookie.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(
  join(here, '..', 'android', 'src', 'com', 'dsh', 'lan', 'MainActivity.java'),
  'utf8',
)
const gateway = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'pair.js'), 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) the credential is persisted and replayed')
{
  check('a storage key exists', app.includes('KEY_DEVICE_COOKIE'))
  check('a remember step exists', app.includes('private void rememberDeviceCookie('))
  check('a restore step exists', app.includes('private void restoreDeviceCookie('))

  // Order matters: restoring after loadUrl would race the very request that needs it.
  const loadIndex = app.indexOf('web.loadUrl(url);')
  const restoreIndex = app.lastIndexOf('restoreDeviceCookie(url);')
  check('the restore happens before the load', restoreIndex > 0 && restoreIndex < loadIndex,
    `restore@${String(restoreIndex)} load@${String(loadIndex)}`)

  check(
    'the cookie is captured on every finished page',
    /onPageFinished[\s\S]{0,600}rememberDeviceCookie\(loaded\)/.test(app),
  )
  check('the capture reads the jar', /rememberDeviceCookie[\s\S]{0,700}getCookie\(/.test(app))
  check('the replay writes the jar', /restoreDeviceCookie[\s\S]{0,700}setCookie\(/.test(app))
  check('the replay sets a lifetime', app.includes('Max-Age='))
  check('the replay flushes to disk', /restoreDeviceCookie[\s\S]{0,900}\.flush\(\)/.test(app))
}

console.log('2) the credential is only offered to a gateway')
{
  // Otherwise the stored secret would be handed to any host the operator types in.
  check('a gateway check exists', app.includes('private static boolean isGatewayUrl('))
  check(
    'the port must match exactly',
    /isGatewayUrl[\s\S]{0,700}endsWith\(GATEWAY_PORT\)/.test(app),
  )
  check('the cookie is not written for other hosts', /restoreDeviceCookie[\s\S]{0,220}!isGatewayUrl\(url\)/.test(app))
  check('the cookie is not read from other hosts', /rememberDeviceCookie[\s\S]{0,220}!isGatewayUrl\(url\)/.test(app))
}

console.log('3) the names agree on both sides of the wire')
{
  // Same class of bug as the device-label length: a constant duplicated in two
  // places drifts and the feature silently stops working.
  const javaName = /DEVICE_COOKIE_PREFIX = "([^"]+)"/.exec(app)?.[1]
  const serverName = /DEVICE_COOKIE = '([^']+)'/.exec(gateway)?.[1]
  check('the app declares the cookie name', typeof javaName === 'string', String(javaName))
  check('the gateway declares the cookie name', typeof serverName === 'string', String(serverName))
  check(
    'the names match',
    javaName === `${serverName}=`,
    `app "${String(javaName)}" vs server "${String(serverName)}="`,
  )

  const javaPort = /GATEWAY_PORT = "(:?\d+)"/.exec(app)?.[1]
  check('the app knows the gateway port', javaPort === ':8791', String(javaPort))
}

console.log('4) the server-side premise still holds: no host in the signature')
{
  // The replay only works because the gateway signs the device id and expiry, not
  // the authority it was paired from.
  check('sign() takes only id and expiry', /#sign\(deviceId, expiresAt\)/.test(gateway))
  check('verify() takes only the credential value', /verify\(value\)/.test(gateway))
  check('no host binding in the store', !/authority/i.test(gateway))
}

console.log('5) a dropped connection re-discovers instead of retrying the old host')
{
  // The app used to keep hammering the address it was opened with, so a network
  // change left the operator staring at a dead page until they restarted it.
  check('a network watcher is registered', app.includes('registerNetworkCallback'))
  check('it watches for loss', /NetworkCallback\(\)[\s\S]{0,400}onLost/.test(app))
  check('it watches for availability', /NetworkCallback\(\)[\s\S]{0,400}onAvailable/.test(app))
  check('it is released on destroy', app.includes('unregisterNetworkCallback'))
  check('a main-frame load error triggers it', /onReceivedError[\s\S]{0,500}scheduleReconnect\(\)/.test(app))
  check(
    'subresource errors are ignored',
    /onReceivedError[\s\S]{0,400}!request\.isForMainFrame\(\)/.test(app),
  )
  const reconnect = methodBody('reconnectToHost')
  check('a reconnect re-runs discovery', reconnect.includes('Discovery.discover('))
  check('the new address is persisted', reconnect.includes('KEY_LAST_URL, url'))
  check('the dead page is dropped first', reconnect.includes('destroyWebView()'))

  // A burst of connectivity callbacks must collapse into one discovery.
  check('a debounce exists', app.includes('RECONNECT_DEBOUNCE_MS'))
  check('concurrent discoveries are blocked', /discoveryInFlight/.test(app))

  // The message the operator actually needs: which two things to check.
  check('a lost-connection screen exists', app.includes('showConnectionLost'))
  check('it names the likely cause', app.includes('手机或电脑的网络可能已经改变'))
  check('it says to check the shared network', app.includes('同一个 Wi-Fi 或热点'))
  check('it offers a manual retry', app.includes('重新查找'))
}

/** Slice one 4-space-indented Java method body; -1 markers yield an empty string. */
function methodBody(name) {
  const start = app.indexOf(`private void ${name}(`)
  if (start < 0) return ''
  const end = app.indexOf('\n    private ', start + 1)
  const alt = app.indexOf('\n    @Override', start + 1)
  const stop = [end, alt].filter((value) => value > 0).sort((a, b) => a - b)[0] ?? app.length
  return app.slice(start, stop)
}

console.log('6) a loaded page is probed, because no load error will ever fire for it')
{
  // The first attempt at this relied on `onReceivedError` and the connectivity
  // callbacks alone, and neither notices a page that is simply OPEN while the host
  // it points at disappears. The heartbeat is the signal that actually works.
  check('a heartbeat exists', app.includes('startHeartbeat'))
  check('it probes a real socket', /probeHostReachable[\s\S]{0,900}new Socket\(\)/.test(app))
  check('the probe has a timeout', app.includes('HEARTBEAT_TIMEOUT_MS'))
  check('the probe targets the loaded address', /probeHostReachable[\s\S]{0,400}KEY_LAST_URL/.test(app))
  check('the probe only runs for a gateway', /probeHostReachable[\s\S]{0,400}isGatewayUrl\(url\)/.test(app))

  // A single flaky timeout must not throw the page away.
  check('one failure is tolerated', app.includes('HEARTBEAT_FAILURES_BEFORE_RECONNECT'))
  check(
    'two failures are required',
    /HEARTBEAT_FAILURES_BEFORE_RECONNECT = 2/.test(app),
    'threshold changed',
  )
  check('a success resets the counter', /heartbeatFailures = 0/.test(app))

  // The heartbeat must not fight the reconnect it just triggered.
  check('it stops while a page is gone', /probeHostReachable\(\)[\s\S]{0,300}web == null/.test(app))
  check('it stops during a reconnect', /probeHostReachable\(\)[\s\S]{0,300}discoveryInFlight/.test(app))
  check('a dead host bypasses the debounce', /heartbeatFailures = 0;[\s\S]{0,200}lastReconnectAt = 0/.test(app))

  // Foreground only: probing in the background would burn battery and data.
  check('it starts on resume', /onResume[\s\S]{0,260}startHeartbeat\(\)/.test(app))
  check('it stops on pause', /onPause[\s\S]{0,260}stopHeartbeat\(\)/.test(app))
}

console.log('7) the text-size control reaches 350% and stays bounded')
{
  // `WebSettings.setTextZoom` takes any integer, so the range is a product choice.
  // The slider and the clamp must agree, or the page ends up scaled by a value the
  // operator can no longer drag back.
  check('a minimum is declared', /MIN_TEXT_ZOOM = (\d+)/.test(app))
  check('a maximum is declared', /MAX_TEXT_ZOOM = (\d+)/.test(app))
  const max = Number(/MAX_TEXT_ZOOM = (\d+)/.exec(app)?.[1] ?? '0')
  const min = Number(/MIN_TEXT_ZOOM = (\d+)/.exec(app)?.[1] ?? '0')
  check('the maximum is 350%', max === 350, String(max))
  check('the minimum is 100%', min === 100, String(min))

  // The slider works in offsets from the minimum; a hardcoded span would drift
  // away from the constants.
  check('the slider span comes from the constants', /setMax\(MAX_TEXT_ZOOM - MIN_TEXT_ZOOM\)/.test(app))
  check('the slider position comes from the constants', /setProgress\(zoom\(\) - MIN_TEXT_ZOOM\)/.test(app))
  check('the applied value comes from the constants', /MIN_TEXT_ZOOM \+ progress/.test(app))
  check('no hardcoded slider span', !/slider\.setMax\(\d+\)/.test(app))

  // A value stored by an older build could sit outside the range.
  check('the stored value is clamped on read', /Math\.max\(MIN_TEXT_ZOOM, Math\.min\(MAX_TEXT_ZOOM/.test(app))
  check('the page is scaled through the clamp', /setTextZoom\(zoom\(\)\)/.test(app))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
