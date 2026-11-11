/**
 * The LAN welcome-dialog suppression.
 *
 * `localStorage` is scoped to an ORIGIN, and a LAN origin contains the machine's
 * address. So every network change is a new origin with empty storage, and any
 * plugin that shows a one-time welcome re-shows it on the phone each time.
 *
 * The gateway re-marks those keys in the document head. This test keeps the shim
 * honest in both directions: it must not fire for loopback (the desktop keeps its
 * real onboarding), and the key it writes must still be the key the other plugin
 * reads — a rename there would otherwise bring the dialog back silently.
 *
 * Run:  node tools/test-lan-welcome.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gateway = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
const configSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'config.js'), 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) the shim is opt-out and declared in the config')
{
  check('the option exists', gateway.includes('hideLanWelcomeHints'))
  check('it defaults to on', /hideLanWelcomeHints:\s*true/.test(configSource))
  check('it is resolved from the row', /hideLanWelcomeHints:\s*asBoolean/.test(configSource))
}

console.log('2) it runs in the head, before any plugin bundle')
{
  check('a script row is injected', /kind:\s*'script'/.test(gateway))
  check('the placement is head', /placement:\s*'head'/.test(gateway))
  check('it is gated by the option', /hideLanWelcomeHints\)\s*\{/.test(gateway))
}

console.log('3) loopback is left alone, so the desktop keeps its onboarding')
{
  // The desktop shell's origin is dsh-app://app and a browser there is 127.0.0.1;
  // suppressing on loopback would hide a dialog the operator has never seen.
  check('127.0.0.1 is skipped', gateway.includes("h==='127.0.0.1'"))
  check('localhost is skipped', gateway.includes("h==='localhost'"))
  check('the IPv6 loopback is skipped', gateway.includes("h==='::1'"))
}

console.log('4) the key still matches the plugin that reads it')
{
  const key = /WELCOME_STORAGE_KEYS = \['([^']+)'\]/.exec(gateway)?.[1]
  check('the gateway declares a key', typeof key === 'string', String(key))

  // Read the other plugin's constant from the live profile; skip when absent.
  const profile = process.env.DSH_PROFILE_DIR ?? 'D:\\A\\DSH\\profiles\\desktop'
  let clientSource = null
  try {
    clientSource = readFileSync(join(profile, 'node_modules', 'dsh-windows-mcp', 'lib', 'client.js'), 'utf8')
  } catch {
    console.log('  SKIP the dsh-windows-mcp bundle is not installed in this profile')
  }
  if (clientSource !== null) {
    const packageId = /var PACKAGE_ID = "([^"]+)"/.exec(clientSource)?.[1]
    const storageKeyPattern = /var WELCOME_STORAGE_KEY = PACKAGE_ID \+ "([^"]+)"/.exec(clientSource)?.[1]
    check('the plugin still derives its key from its package id', typeof packageId === 'string', String(packageId))
    check('the suffix is unchanged', storageKeyPattern === ':welcome', String(storageKeyPattern))
    check(
      'the keys match',
      key === `${String(packageId)}${String(storageKeyPattern)}`,
      `gateway "${String(key)}" vs plugin "${String(packageId)}${String(storageKeyPattern)}"`,
    )
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
