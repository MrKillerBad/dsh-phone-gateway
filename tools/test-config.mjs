/**
 * Config resolution test: the README's YAML example must survive resolution,
 * and malformed values must fall back rather than break the listener.
 *
 * Run:  node tools/test-config.mjs
 */

import { DEFAULTS, resolveConfig } from '../dsh-phone-gateway/lib/config.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
}

console.log('1) empty config yields every documented default')
{
  const c = resolveConfig(undefined)
  for (const [key, expected] of Object.entries(DEFAULTS)) {
    check(`${key} = ${JSON.stringify(expected)}`, JSON.stringify(c[key]) === JSON.stringify(expected), JSON.stringify(c[key]))
  }
}

console.log('2) the README example resolves field by field')
{
  // Exactly the values printed in README's config block.
  const c = resolveConfig({
    port: 8791,
    bindAll: true,
    restrictSameSubnet: true,
    allowSubnets: ['192.168.1.0/24'],
    injectMobileViewport: true,
    deviceTtlDays: 180,
    enabled: true,
  })
  check('port', c.port === 8791)
  check('bindAll', c.bindAll === true)
  check('restrictSameSubnet', c.restrictSameSubnet === true)
  check('allowSubnets', JSON.stringify(c.allowSubnets) === '["192.168.1.0/24"]')
  check('injectMobileViewport', c.injectMobileViewport === true)
  check('deviceTtlDays', c.deviceTtlDays === 180)
  check('enabled', c.enabled === true)
}

console.log('3) malformed values fall back instead of throwing')
{
  const cases = [
    ['port as text', { port: 'not-a-port' }, 'port', DEFAULTS.port],
    ['port out of range', { port: 70000 }, 'port', DEFAULTS.port],
    ['port zero', { port: 0 }, 'port', DEFAULTS.port],
    ['bindAll as string', { bindAll: 'yes' }, 'bindAll', DEFAULTS.bindAll],
    ['allowSubnets not an array', { allowSubnets: '192.168.1.0/24' }, 'allowSubnets', DEFAULTS.allowSubnets],
    ['allowSubnets with junk', { allowSubnets: ['1.2.3.0/24', 42, null] }, 'allowSubnets', ['1.2.3.0/24']],
    ['deviceTtlDays negative', { deviceTtlDays: -5 }, 'deviceTtlDays', DEFAULTS.deviceTtlDays],
  ]
  for (const [name, raw, key, expected] of cases) {
    let threw = false
    let c
    try {
      c = resolveConfig(raw)
    } catch (error) {
      threw = true
      console.log(`     threw: ${error.message}`)
    }
    check(`${name} → no throw`, threw === false)
    if (!threw) check(`${name} → ${JSON.stringify(expected)}`, JSON.stringify(c[key]) === JSON.stringify(expected), JSON.stringify(c[key]))
  }
}

console.log('4) non-object config is tolerated')
{
  let threw = false
  for (const raw of [null, 'text', 42, []]) {
    try {
      resolveConfig(raw)
    } catch (error) {
      threw = true
      console.log(`     threw on ${JSON.stringify(raw)}: ${error.message}`)
    }
  }
  check('no throw for scalar/array/null config', threw === false)
}

console.log('5) unknown keys are dropped')
{
  const c = resolveConfig({ port: 9000, somethingElse: true })
  check('port kept', c.port === 9000)
  check('unknown key dropped', c.somethingElse === undefined)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
