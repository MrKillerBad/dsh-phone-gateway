/**
 * Network facts the gateway needs: address normalization, loopback
 * classification, and the same-subnet gate that keeps the LAN listener from
 * serving a network it was not opened for.
 */

import { networkInterfaces } from 'node:os'

/**
 * Turn an IPv4-mapped IPv6 text form into plain IPv4.
 * A phone reaching a dual-stack socket shows up as `::ffff:192.168.x.x`; every
 * address comparison in this package runs on the normalized text so the two
 * spellings of one peer never disagree.
 */
export function normalizeAddress(address) {
  if (typeof address !== 'string') return undefined
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped === null ? address : mapped[1]
}

/** Loopback check covering `127/8`, `::1`, and their mapped forms. */
export function isLoopback(address) {
  const text = normalizeAddress(address)
  if (text === undefined) return false
  if (text === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)
}

/** Dotted quad to a 32-bit unsigned integer, or undefined when malformed. */
function ipv4ToInt(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}

/**
 * The first 64 bits of an IPv6 address, which is the prefix a link-local or
 * routed LAN shares in practice. Zone ids (`fe80::1%12`) are dropped first.
 */
function ipv6Prefix64(text) {
  const bare = text.split('%')[0]
  if (!bare.includes(':')) return undefined
  const [head, tail] = bare.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined ? [] : tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  if (tail !== undefined && missing < 0) return undefined
  const parts = tail === undefined ? headParts : [...headParts, ...Array(missing).fill('0'), ...tailParts]
  if (parts.length < 4) return undefined
  return parts.slice(0, 4).map((part) => part.toLowerCase().replace(/^0+(?=.)/, '')).join(':')
}

/** Interfaces a phone could actually be on: every non-internal address. */
export function listInterfaces() {
  const out = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 'IPv6') continue
      out.push({ name, address: entry.address, family: entry.family, netmask: entry.netmask })
    }
  }
  return out
}

/** Whether an address sits on a network this machine is directly attached to. */
function onLocalSubnet(address, interfaces) {
  const remote4 = ipv4ToInt(address)
  if (remote4 !== undefined) {
    for (const entry of interfaces) {
      if (entry.family !== 'IPv4') continue
      const local4 = ipv4ToInt(entry.address)
      const mask4 = ipv4ToInt(entry.netmask)
      if (local4 === undefined || mask4 === undefined) continue
      if ((remote4 & mask4) >>> 0 === (local4 & mask4) >>> 0) return true
    }
    return false
  }
  const remote6 = ipv6Prefix64(address)
  if (remote6 === undefined) return false
  for (const entry of interfaces) {
    if (entry.family !== 'IPv6') continue
    if (ipv6Prefix64(entry.address) === remote6) return true
  }
  return false
}

/**
 * Extra networks the operator allowed explicitly, as `a.b.c.d/len` or a bare
 * address (a single host). IPv4 only: an IPv6 allow-list here would silently
 * widen the listener past what the operator typed.
 */
function inAllowedSubnets(address, allowSubnets) {
  const remote4 = ipv4ToInt(address)
  if (remote4 === undefined) return false
  for (const entry of allowSubnets) {
    const [network, bits] = String(entry).split('/')
    const network4 = ipv4ToInt(network)
    if (network4 === undefined) continue
    const length = bits === undefined ? 32 : Number(bits)
    if (!Number.isInteger(length) || length < 0 || length > 32) continue
    const mask4 = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0
    if ((remote4 & mask4) >>> 0 === (network4 & mask4) >>> 0) return true
  }
  return false
}

/**
 * Decide whether one inbound request may be served.
 *
 * Loopback always passes: that is the operator's own machine, and it is how the
 * desktop browser and the diagnostic probe reach the gateway. A LAN peer passes
 * only when it shares a subnet with an interface of this machine, or matches an
 * explicitly allowed network. `restrictSameSubnet: false` lifts the check.
 */
export function isAllowedPeer(remoteAddress, options = {}) {
  const address = normalizeAddress(remoteAddress)
  if (address === undefined) return false
  if (isLoopback(address)) return true
  if (Array.isArray(options.allowSubnets) && inAllowedSubnets(address, options.allowSubnets)) return true
  if (options.restrictSameSubnet === false) return true
  return onLocalSubnet(address, listInterfaces())
}

/**
 * This machine's address on the network the peer is on.
 *
 * Discovery must answer with an address the caller can actually dial, and a
 * laptop with several interfaces (WiFi, hotspot, VPN) has several candidates.
 * The peer's own address picks the interface: whichever local address shares
 * its subnet is the one it can reach.
 *
 * @param {string} remoteAddress - the querier's address, any supported spelling.
 * @returns {string|undefined} a local IPv4 address, or undefined when no
 * interface shares a subnet with the peer.
 */
export function localAddressFor(remoteAddress) {
  const address = normalizeAddress(remoteAddress)
  const remote4 = address === undefined ? undefined : ipv4ToInt(address)
  if (remote4 === undefined) return undefined
  for (const entry of listInterfaces()) {
    if (entry.family !== 'IPv4') continue
    const local4 = ipv4ToInt(entry.address)
    const mask4 = ipv4ToInt(entry.netmask)
    if (local4 === undefined || mask4 === undefined) continue
    if ((remote4 & mask4) >>> 0 === (local4 & mask4) >>> 0) return entry.address
  }
  return undefined
}
