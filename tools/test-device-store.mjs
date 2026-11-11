/**
 * Regression test for the crash that took DSH down.
 *
 * `DeviceStore.verify()` is synchronous and runs inside the request handler.
 * Before the fix it called `createHmac('sha256', null)` when the store had not
 * loaded yet, which throws ERR_INVALID_ARG_TYPE and killed the host process.
 *
 * Run:  node tools/test-device-store.mjs
 */

import { DEVICE_LABEL_MAX, DeviceStore, normalizeDeviceLabel } from '../dsh-phone-gateway/lib/pair.js'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

const dir = await mkdtemp(join(tmpdir(), 'lan-gw-test-'))
const path = join(dir, 'devices.json')

console.log('1) verify() before load() must NOT throw')
{
  const store = new DeviceStore(path)
  let threw = false
  let result
  try {
    result = store.verify('abc.123.def')
  } catch (error) {
    threw = true
    console.log(`     threw: ${error.message}`)
  }
  check('no throw with unloaded store', threw === false)
  check('unloaded store reports "not paired"', result === undefined)
}

console.log('2) verify() rejects malformed values without throwing')
{
  const store = new DeviceStore(path)
  await store.load()
  const inputs = [undefined, null, '', 'a', 'a.b', 'a.b.c.d', 'x.notanumber.sig', '..', 'a..c']
  let threw = false
  for (const input of inputs) {
    try {
      const out = store.verify(input)
      if (out !== undefined) check(`rejects ${JSON.stringify(input)}`, false)
    } catch (error) {
      threw = true
      console.log(`     threw on ${JSON.stringify(input)}: ${error.message}`)
    }
  }
  check('malformed values handled without throwing', threw === false)
}

console.log('3) pairing → verify → revoke round trip')
{
  const store = new DeviceStore(path)
  await store.load()
  const issued = await store.issueCode()
  check('code is 6 digits', /^\d{6}$/.test(issued.code), issued.code)

  const paired = await store.pair(issued.code, 'test-phone')
  check('pair succeeded', paired.cookie !== undefined && paired.deviceId !== undefined)

  const verified = store.verify(paired.cookie)
  check('cookie verifies', verified?.id === paired.deviceId)

  const tampered = `${paired.cookie.slice(0, -2)}XX`
  check('tampered cookie rejected', store.verify(tampered) === undefined)

  const revoked = await store.revoke(paired.deviceId)
  check('revoke returns true', revoked === true)
  check('revoked device no longer verifies', store.verify(paired.cookie) === undefined)
}

console.log('4) a fresh instance loads the persisted secret and list')
{
  const first = new DeviceStore(path)
  await first.load()
  const code = await first.issueCode()
  const paired = await first.pair(code.code, 'persisted-phone')

  // A second instance stands in for a DSH restart.
  const second = new DeviceStore(path)
  await second.load()
  check('device survives reload', second.list().some((d) => d.id === paired.deviceId))
  check('cookie still verifies after reload', second.verify(paired.cookie)?.id === paired.deviceId)
}

console.log('5) brute-force lockout')
{
  const store = new DeviceStore(join(dir, 'lockout.json'))
  await store.load()
  await store.issueCode()
  let last
  for (let attempt = 0; attempt < 5; attempt += 1) last = await store.pair('000000', 'x')
  check('code burns after 5 attempts', last.error === 'too-many-attempts', String(last.error))
  const after = await store.pair('000000', 'x')
  check('no code remains', after.error === 'no-active-code', String(after.error))
}

console.log('6) re-pairing the same device replaces its row instead of adding one')
{
  // Reinstalling the app wipes the cookie jar, so the phone returns as a stranger
  // with an identical User-Agent. Without this rule every reinstall left another
  // identical row in the device list.
  const lone = new DeviceStore(join(dir, 'lone.json'))
  await lone.load()

  const phone = 'Mozilla/5.0 (Linux; Android 17; X) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
  const firstCode = (await lone.issueCode()).code
  const first = await lone.pair(firstCode, phone)
  check('first pairing succeeds', typeof first.deviceId === 'string', String(first.error))
  check('one device recorded', lone.list().length === 1, String(lone.list().length))

  const secondCode = (await lone.issueCode()).code
  const second = await lone.pair(secondCode, phone)
  check('second pairing succeeds', typeof second.deviceId === 'string', String(second.error))
  check('still one device', lone.list().length === 1, String(lone.list().length))
  check('the new id is the surviving one', lone.list()[0].id === second.deviceId)
  check('the replacement is reported', second.superseded === 1, String(second.superseded))

  // The old credential must be dead: the record it signed is gone.
  check('the replaced cookie no longer verifies', lone.verify(first.cookie) === undefined)

  // A genuinely different device keeps its own row.
  const tablet = 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/120'
  const thirdCode = (await lone.issueCode()).code
  await lone.pair(thirdCode, tablet)
  check('a different device is added', lone.list().length === 2, String(lone.list().length))
}

console.log('7) the label length is one number, shared with the pair page')
{
  const source = readFileSync(
    join(here, '..', 'dsh-phone-gateway', 'lib', 'pair-page.js'),
    'utf8',
  )
  check('the label limit is exported', typeof DEVICE_LABEL_MAX === 'number', String(DEVICE_LABEL_MAX))
  check(
    'the pair page uses the shared constant',
    /navigator\.userAgent\.slice\(0, \$\{String\(DEVICE_LABEL_MAX\)\}\)/.test(source),
  )
  check('no hardcoded literal remains in the page', !/userAgent\.slice\(0, \d+\)/.test(source))
  // The store truncates too; if the two disagreed, the same phone produced two
  // labels and the duplicate came back (this actually happened at 100 vs 120).
  check(
    'the store normalizes to the same length',
    normalizeDeviceLabel('x'.repeat(500)).length === DEVICE_LABEL_MAX,
    String(normalizeDeviceLabel('x'.repeat(500)).length),
  )
  check('an empty label gets a readable fallback', normalizeDeviceLabel('') === 'Paired device')
}

console.log('8) a store written by an older build collapses on load')
{
  // Older builds stored labels at a different length, so one phone could appear
  // twice under labels that differ only in where they were cut.
  const legacyPath = join(dir, 'legacy.json')
  const longUa =
    'Mozilla/5.0 (Linux; Android 17; 2602BRT18C Build/CP2A.260605.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36'
  const older = { id: 'olderRow', label: longUa.slice(0, 100), issuedAt: 1_700_000_000_000, expiresAt: 9e15, lastSeenAt: 0 }
  const newer = { id: 'newerRow', label: longUa.slice(0, 120), issuedAt: 1_700_000_100_000, expiresAt: 9e15, lastSeenAt: 0 }
  await writeFile(
    legacyPath,
    JSON.stringify({ version: 1, secret: 'A'.repeat(43), devices: [older, newer] }),
    'utf8',
  )

  const repaired = new DeviceStore(legacyPath)
  await repaired.load()
  check('the duplicate is removed', repaired.list().length === 1, String(repaired.list().length))
  check('the newest survives', repaired.list()[0].id === 'newerRow', repaired.list()[0].id)
  check(
    'the label is normalized',
    repaired.list()[0].label.length === DEVICE_LABEL_MAX,
    String(repaired.list()[0].label.length),
  )
  check('the collapse is reported', repaired.collapsedOnLoad === 1, String(repaired.collapsedOnLoad))

  // The repaired file must be what a later start reads, not re-collapsed each time.
  const reread = new DeviceStore(legacyPath)
  await reread.load()
  check('the repair was persisted', reread.list().length === 1, String(reread.list().length))
  check('nothing left to collapse', reread.collapsedOnLoad === 0, String(reread.collapsedOnLoad))
}

console.log('9) the control-slot role: first phone wins, the operator can move it')
{
  const role = new DeviceStore(join(dir, 'role.json'))
  await role.load()
  check('nobody holds the role before pairing', role.primaryId === null, String(role.primaryId))

  const first = await role.pair((await role.issueCode()).code, 'phone-one')
  check('the first phone becomes primary', role.primaryId === first.deviceId, String(role.primaryId))

  const second = await role.pair((await role.issueCode()).code, 'phone-two')
  check('a later phone does not take the role', role.primaryId === first.deviceId, String(role.primaryId))
  check('it is paired all the same', role.list().length === 2, String(role.list().length))

  check('the operator can move the role', (await role.setPrimary(second.deviceId)) === true)
  check('the new device holds it', role.primaryId === second.deviceId, String(role.primaryId))
  check('moving it again is a no-op', (await role.setPrimary(second.deviceId)) === false)
  check('an unknown device is refused', (await role.setPrimary('nope')) === false)
  check('the role survives the refusal', role.primaryId === second.deviceId)

  // Persistence: a restart must not re-run "first phone wins".
  const reloaded = new DeviceStore(join(dir, 'role.json'))
  await reloaded.load()
  check('the role survives a restart', reloaded.primaryId === second.deviceId, String(reloaded.primaryId))

  // Revoking the holder must PROMOTE a survivor: an empty role collapses every rule
  // into first-come-first-served and leaves the page with no badge at all.
  await reloaded.revoke(second.deviceId)
  check('revoking the primary promotes the longest-paired survivor', reloaded.primaryId === first.deviceId, String(reloaded.primaryId))
  const third = await reloaded.pair((await reloaded.issueCode()).code, 'phone-three')
  check('a later pairing does not take the role from the survivor', reloaded.primaryId === first.deviceId, String(reloaded.primaryId))
  await reloaded.revoke(first.deviceId)
  check('revoking again promotes the next oldest', reloaded.primaryId === third.deviceId, String(reloaded.primaryId))
}

console.log('10) a store written before the role existed gets one backfilled')
{
  const legacy = join(dir, 'legacy-role.json')
  await writeFile(
    legacy,
    JSON.stringify({
      version: 1,
      secret: 'B'.repeat(43),
      devices: [
        { id: 'old', label: 'older phone', issuedAt: 1_700_000_000_000, expiresAt: 9e15, lastSeenAt: 0 },
        { id: 'new', label: 'newer phone', issuedAt: 1_700_000_900_000, expiresAt: 9e15, lastSeenAt: 0 },
      ],
    }),
    'utf8',
  )
  const backfilled = new DeviceStore(legacy)
  await backfilled.load()
  check('the oldest pairing becomes primary', backfilled.primaryId === 'old', String(backfilled.primaryId))

  const reread = new DeviceStore(legacy)
  await reread.load()
  check('the backfill was persisted', reread.primaryId === 'old', String(reread.primaryId))
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
