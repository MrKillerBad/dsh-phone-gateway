/**
 * Subnet gate test: the README promises same-subnet-only access with an
 * explicit allow-list escape hatch. This proves the predicate, including the
 * IPv4-mapped IPv6 form a phone actually arrives as.
 *
 * Run:  node tools/test-net.mjs
 */

import { isAllowedPeer, isLoopback, listInterfaces, normalizeAddress } from '../dsh-phone-gateway/lib/net.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) address normalization')
{
  check('mapped v4 → v4', normalizeAddress('::ffff:192.168.1.5') === '192.168.1.5')
  check('plain v4 untouched', normalizeAddress('192.168.1.5') === '192.168.1.5')
  check('v6 untouched', normalizeAddress('fe80::1') === 'fe80::1')
  check('undefined stays undefined', normalizeAddress(undefined) === undefined)
}

console.log('2) loopback forms')
{
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    check(`${address} is loopback`, isLoopback(address) === true)
  }
  for (const address of ['192.168.1.5', '10.0.0.1', '::ffff:10.61.18.139']) {
    check(`${address} is not loopback`, isLoopback(address) === false)
  }
}

console.log('3) loopback always passes, whatever the config')
{
  const strict = { restrictSameSubnet: true, allowSubnets: [] }
  check('loopback allowed', isAllowedPeer('127.0.0.1', strict) === true)
  check('::1 allowed', isAllowedPeer('::1', strict) === true)
}

console.log('4) same-subnet gating uses this machine\'s real interfaces')
{
  const interfaces = listInterfaces()
  const v4 = interfaces.find((entry) => entry.family === 'IPv4')
  console.log(`     machine IPv4: ${v4 === undefined ? '(none)' : `${v4.address}/${v4.netmask}`}`)
  if (v4 !== undefined) {
    // A neighbor inside the same /24 as the real interface, not the interface itself.
    const parts = v4.address.split('.')
    const neighbor = `${parts[0]}.${parts[1]}.${parts[2]}.250`
    const otherNetwork = '203.0.113.7'

    check(
      `neighbor ${neighbor} allowed by same-subnet rule`,
      isAllowedPeer(neighbor, { restrictSameSubnet: true, allowSubnets: [] }) === true,
    )
    check(
      `foreign ${otherNetwork} refused`,
      isAllowedPeer(otherNetwork, { restrictSameSubnet: true, allowSubnets: [] }) === false,
    )
    check(
      `mapped form of neighbor allowed`,
      isAllowedPeer(`::ffff:${neighbor}`, { restrictSameSubnet: true, allowSubnets: [] }) === true,
    )
    check(
      `restrictSameSubnet:false lifts the check`,
      isAllowedPeer(otherNetwork, { restrictSameSubnet: false, allowSubnets: [] }) === true,
    )
    check(
      `allowSubnets admits ${otherNetwork}`,
      isAllowedPeer(otherNetwork, { restrictSameSubnet: true, allowSubnets: [`${otherNetwork}/32`] }) === true,
    )
    check(
      `a /24 in the list is honored`,
      isAllowedPeer('198.51.100.9', { restrictSameSubnet: true, allowSubnets: ['198.51.100.0/24'] }) === true,
    )
    check(
      `an unrelated /24 is not`,
      isAllowedPeer('198.51.100.9', { restrictSameSubnet: true, allowSubnets: ['198.51.101.0/24'] }) === false,
    )
  }
}

console.log('5) garbage input never allows and never throws')
{
  let threw = false
  for (const address of [undefined, '', 'not-an-ip', '999.1.1.1', '::ffff:zzz']) {
    try {
      const result = isAllowedPeer(address, { restrictSameSubnet: true, allowSubnets: [] })
      if (result !== false) check(`rejects ${JSON.stringify(address)}`, false)
    } catch (error) {
      threw = true
      console.log(`     threw on ${JSON.stringify(address)}: ${error.message}`)
    }
  }
  check('no throw for malformed addresses', threw === false)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
