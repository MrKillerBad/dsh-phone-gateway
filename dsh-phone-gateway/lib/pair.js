/**
 * Pairing and the device allow-list — the gateway's own authentication chain.
 *
 * The design asks for two independent chains, and this is the first one:
 *
 *   phone → gateway   a gateway-signed device cookie, minted when the operator
 *                     types a 6-digit pairing code shown on the computer.
 *
 * Why a second chain at all: once the LAN listener is open, every device that
 * can reach the port could otherwise drive DSH — running tools approvals
 * included. The DSH cookie is the gateway's own credential and is never handed
 * out (rule 2), so it cannot double as the phone's credential.
 *
 * The code is shown at the computer only (`GET /__lan/pair`, loopback-only),
 * lives for a few minutes, and is single-use. The device cookie is an HMAC over
 * the device id with a secret stored outside the workspace, so a device can be
 * revoked by deleting its record — no code deploy, no restart.
 *
 * Storage layout: `<DSH home>/storages/lan-gateway/devices.json`, matching the
 * convention the other packages already use under `storages/`. The secret and
 * the device list live in one file so a single atomic write keeps them in sync.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Pairing code lifetime: long enough to type on a phone, short enough to be safe. */
const CODE_TTL_MS = 3 * 60 * 1000

/** A pairing attempt may be retried this many times before the code is burned. */
const MAX_CODE_ATTEMPTS = 5

/** Cookie name of the gateway's own device credential; deliberately not `dsh-auth-*`. */
export const DEVICE_COOKIE = 'dsh-phone-gateway-device'

/**
 * Longest stored device label, in characters.
 *
 * The pair page builds the label from the User-Agent and the store normalizes it
 * again; the two MUST agree, because the label is what identifies a re-pairing
 * device. When they disagreed (100 in the page, 120 in the store) the same phone
 * produced two different labels and its duplicate row came back.
 */
export const DEVICE_LABEL_MAX = 100

/**
 * The one canonical form of a device label.
 *
 * Both the store and the pair page run through this, so a re-pairing device always
 * produces a byte-identical label — which is what lets pairing replace its own
 * previous row instead of adding one.
 *
 * @param {unknown} raw - the label as received, usually a User-Agent.
 * @returns {string} a trimmed label of at most {@link DEVICE_LABEL_MAX} characters.
 */
export function normalizeDeviceLabel(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return (text === '' ? 'Paired device' : text).slice(0, DEVICE_LABEL_MAX)
}

/** Page served to an unpaired device. */
export const PAIR_PAGE_PATH = '/__lan/pair'

/**
 * The directory DSH keeps its per-package state: `$DSH_HOME/storages`, the same
 * root `workspace.json` already uses. `DSH_HOME` is the documented override.
 */
function storageRoot() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'storages')
  return join(process.cwd(), '.dsh', 'storages')
}

/** Where the gateway's devices and signing secret live. */
export function storePath() {
  return join(storageRoot(), 'lan-gateway', 'devices.json')
}

/** Constant-time string compare that tolerates different lengths. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Owner of the pairing codes, the device list, and the signing secret.
 *
 * Every read is served from memory after the first load; every write goes to
 * disk through an atomic rename so a crash cannot leave a half-written file
 * that would lock the operator out of their own gateway.
 */
export class DeviceStore {
  #path
  #secret = null
  #devices = new Map()
  #loaded = false
  #pendingWrite = Promise.resolve()

  /** The active pairing code, or null when none was requested. */
  #code = null
  #codeIssuedAt = 0
  #codeAttempts = 0

  constructor(path = storePath()) {
    this.#path = path
  }

  /**
   * Load the store and make the signing key available.
   *
   * The caller MUST await this before the listener starts accepting requests:
   * `verify` is synchronous and cannot load on demand. Loading is idempotent,
   * so a second call is free.
   */
  async load() {
    await this.#ensureLoaded()
    return this
  }

  /** Load the store once; a missing or corrupt file starts empty, never throws. */
  async #ensureLoaded() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const text = await readFile(this.#path, 'utf8')
      const parsed = JSON.parse(text)
      if (typeof parsed?.secret === 'string' && parsed.secret.length >= 32) {
        this.#secret = parsed.secret
      }
      if (typeof parsed?.primaryDeviceId === 'string') {
        this.#primaryDeviceId = parsed.primaryDeviceId
      }
      if (Array.isArray(parsed?.devices)) {
        for (const device of parsed.devices) {
          if (typeof device?.id === 'string' && typeof device?.issuedAt === 'number') {
            // Re-normalize: older builds stored labels at a different length, so the
            // same phone could appear twice under labels that differ only in how
            // they were cut. The id and cookie are untouched — only the display text.
            this.#devices.set(device.id, {
              ...device,
              label: normalizeDeviceLabel(device.label),
            })
          }
        }
        this.#collapseDuplicates()
      }
    } catch (error) {
      // A missing file is the first run. A corrupt one is reported by the
      // caller's log, but an empty store is still the safe starting point:
      // every device simply has to pair again.
      if (error?.code !== 'ENOENT') this.#loadError = error
    }
    if (this.#secret === null) this.#secret = randomBytes(32).toString('base64url')
    // Two repairs are possible on load, and each has its own report: duplicate rows
    // collapsed, and a primary role adopted for stores written before it existed.
    let changed = this.#collapsedOnLoad > 0
    if (this.#adoptOldestAsPrimary()) changed = true
    // Write the repaired list back once, so the file is repaired rather than
    // re-repaired on every start. A failure here is not worth reporting: the
    // in-memory state is already correct.
    if (changed) await this.#persist().catch(() => undefined)
  }

  /**
   * Drop the older rows of a device that appears under one label more than once.
   *
   * Older builds appended a row on every reinstall, so an existing store can hold
   * the same phone two or three times. Collapsing on load repairs that once; the
   * pairing path now prevents it from happening again.
   *
   * The newest row wins — the one whose cookie the phone is most likely still
   * holding.
   */
  #collapseDuplicates() {
    const newestByLabel = new Map()
    for (const device of this.#devices.values()) {
      const previous = newestByLabel.get(device.label)
      if (previous === undefined || (device.issuedAt ?? 0) > (previous.issuedAt ?? 0)) {
        newestByLabel.set(device.label, device)
      }
    }
    let removed = 0
    for (const device of [...this.#devices.values()]) {
      if (newestByLabel.get(device.label) !== device) {
        this.#devices.delete(device.id)
        removed += 1
      }
    }
    this.#collapsedOnLoad = removed
  }

  /** How many duplicate rows the last load removed; 0 when the store was clean. */
  #collapsedOnLoad = 0

  get collapsedOnLoad() {
    return this.#collapsedOnLoad
  }

  /** The load failure, when the store file existed but could not be read. */
  #loadError = null

  get loadError() {
    return this.#loadError
  }

  /** Serialize writes so two pairings cannot interleave and drop one. */
  #persist() {
    const snapshot = {
      version: 1,
      secret: this.#secret,
      primaryDeviceId: this.#primaryDeviceId,
      devices: [...this.#devices.values()],
    }
    this.#pendingWrite = this.#pendingWrite.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(temporary, this.#path)
    })
    return this.#pendingWrite
  }

  /**
   * Issue a fresh 6-digit code. Any previous code is replaced, so only the most
   * recently displayed one works.
   * @returns {{code: string, expiresAt: number}} the code to show on the computer.
   */
  async issueCode() {
    await this.#ensureLoaded()
    // randomInt is uniform; `Math.random` would bias the first digits.
    this.#code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.#codeIssuedAt = Date.now()
    this.#codeAttempts = 0
    return { code: this.#code, expiresAt: this.#codeIssuedAt + CODE_TTL_MS }
  }

  /**
   * The current code and its remaining lifetime, for the loopback page.
   * Reading is idempotent: the operator's page polls this on every render, so a
   * getter that consumed the code would make its own display disappear.
   */
  codeStatus() {
    if (this.#code === null) return null
    const expiresAt = this.#codeIssuedAt + CODE_TTL_MS
    if (Date.now() >= expiresAt) return null
    return { code: this.#code, expiresAt, attemptsLeft: MAX_CODE_ATTEMPTS - this.#codeAttempts }
  }

  /**
   * Redeem a code for a device credential.
   *
   * A wrong code burns one attempt and a served code is consumed on success, so
   * a 6-digit space cannot be brute-forced: 5 tries per code, and a new code
   * only appears when the operator asks at the computer.
   *
   * @param {string} submitted - the code typed on the phone.
   * @param {string} label - a human label for the device list.
   * @returns {Promise<{deviceId: string, cookie: string, expiresAt: number} | {error: string}>}
   */
  async pair(submitted, label) {
    await this.#ensureLoaded()
    const active = this.codeStatus()
    if (active === null) return { error: 'no-active-code' }
    if (!/^\d{6}$/.test(String(submitted ?? ''))) {
      this.#codeAttempts += 1
      return { error: this.#codeAttempts >= MAX_CODE_ATTEMPTS ? 'too-many-attempts' : 'bad-code' }
    }
    if (!safeEqual(submitted, active.code)) {
      this.#codeAttempts += 1
      if (this.#codeAttempts >= MAX_CODE_ATTEMPTS) {
        this.#code = null
        return { error: 'too-many-attempts' }
      }
      return { error: 'bad-code' }
    }

    // Single use: consume before handing out the credential.
    this.#code = null
    const deviceId = randomBytes(16).toString('base64url')
    const now = Date.now()
    const ttlDays = this.#ttlDays
    const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000
    const deviceLabel = normalizeDeviceLabel(label)
    const record = {
      id: deviceId,
      label: deviceLabel,
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
    }

    // Pairing again from a device that is already on the list REPLACES it.
    //
    // Reinstalling the app wipes its cookie jar, so the phone comes back as a
    // stranger and would otherwise accumulate one identical row per reinstall.
    // The label is the browser User-Agent — model, OS and build — which is as close
    // to "the same phone" as the gateway can get without a credential it cannot see
    // yet. A second physically identical phone is the cost: it is signed out and
    // pairs again with a code, which is recoverable; an ever-growing list is not.
    const superseded = [...this.#devices.values()].filter(
      (existing) => existing.label === deviceLabel && existing.id !== deviceId,
    )
    for (const existing of superseded) this.#devices.delete(existing.id)

    this.#devices.set(deviceId, record)
    // The first phone to pair owns the control slot until the operator moves it.
    if (this.#primaryDeviceId === null || !this.#devices.has(this.#primaryDeviceId)) {
      this.#primaryDeviceId = deviceId
    }
    await this.#persist()
    if (superseded.length > 0) {
      // Reported by the caller; the pairing itself succeeded.
      return {
        deviceId,
        cookie: this.#sign(deviceId, expiresAt),
        expiresAt,
        superseded: superseded.length,
      }
    }
    return { deviceId, cookie: this.#sign(deviceId, expiresAt), expiresAt }
  }

  /**
   * Make the longest-paired device the primary when the role is empty.
   *
   * The role must be owned whenever any device exists: with no primary every rule
   * collapses to first-come-first-served, the page shows no badge, and nobody can
   * deliberately take the seat back.
   *
   * @returns {boolean} whether a device was adopted.
   */
  #adoptOldestAsPrimary() {
    if (this.#devices.has(this.#primaryDeviceId ?? '')) return false
    if (this.#devices.size === 0) {
      this.#primaryDeviceId = null
      return false
    }
    const oldest = [...this.#devices.values()].reduce((left, right) =>
      (left.issuedAt ?? 0) <= (right.issuedAt ?? 0) ? left : right,
    )
    this.#primaryDeviceId = oldest.id
    return true
  }

  /** Days a device stays paired; set before pairing by the caller. */
  #ttlDays = 180

  /**
   * The device that owns the one control slot, or null before anyone paired.
   *
   * The first phone to pair becomes primary. A device only holds ONE of the two
   * roles at a time, and the role survives restarts because it is persisted with
   * the device list.
   */
  #primaryDeviceId = null

  /** The primary device id, or null when nobody has paired yet. */
  get primaryId() {
    if (this.#primaryDeviceId === null) return null
    // A revoked or superseded device must not keep the role.
    return this.#devices.has(this.#primaryDeviceId) ? this.#primaryDeviceId : null
  }

  /**
   * Hand the primary role to an existing device.
   *
   * @param {string} deviceId - a paired device.
   * @returns {Promise<boolean>} whether the role moved.
   */
  async setPrimary(deviceId) {
    await this.#ensureLoaded()
    if (typeof deviceId !== 'string' || !this.#devices.has(deviceId)) return false
    if (this.#primaryDeviceId === deviceId) return false
    this.#primaryDeviceId = deviceId
    await this.#persist()
    return true
  }

  setDeviceTtlDays(days) {
    if (Number.isInteger(days) && days > 0) this.#ttlDays = days
  }

  /**
   * The signing secret, or a hard failure.
   *
   * `verify` is SYNCHRONOUS: it runs inside the request handler, where an
   * uncaught throw takes the whole DSH process down (this shipped once, on the
   * first request after a restart, because the secret is assigned by an async
   * load). `createHmac(key, null)` throws ERR_INVALID_ARG_TYPE, so every caller
   * of a signing operation must go through here, and `load()` must have
   * completed before any request is served.
   */
  #signingKey() {
    if (typeof this.#secret === 'string' && this.#secret.length > 0) return this.#secret
    throw new Error('lan-gateway: device store used before load() completed')
  }

  /** `deviceId.expiresAt.signature`, so expiry needs no extra lookup. */
  #sign(deviceId, expiresAt) {
    const body = `${deviceId}.${expiresAt}`
    const mac = createHmac('sha256', this.#signingKey()).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  /**
   * Validate a device cookie.
   *
   * Synchronous because the request path cannot await, so it must never throw:
   * a malformed or unverifiable cookie is simply "not paired".
   *
   * @param {string|undefined} value - the raw cookie value.
   * @returns {{id: string, record: object} | undefined} the matched device.
   */
  verify(value) {
    if (typeof value !== 'string' || value === '') return undefined
    // Before `load()` resolves there is no key to verify with; the next request
    // after activation will succeed. Returning undefined lands the device on the
    // pairing page, which is the correct answer for "not provably paired".
    if (typeof this.#secret !== 'string' || this.#secret.length === 0) return undefined

    const parts = value.split('.')
    if (parts.length !== 3) return undefined
    const [deviceId, expiresAtText, mac] = parts
    const expiresAt = Number(expiresAtText)
    if (!Number.isFinite(expiresAt)) return undefined

    try {
      const expected = createHmac('sha256', this.#secret)
        .update(`${deviceId}.${expiresAtText}`)
        .digest('base64url')
      if (!safeEqual(mac, expected)) return undefined
    } catch {
      return undefined
    }

    if (Date.now() >= expiresAt) return undefined

    const record = this.#devices.get(deviceId)
    if (record === undefined) return undefined
    // The record may have been revoked (deleted) while the cookie stayed valid.
    return { id: deviceId, record }
  }

  /** Mark a verified device as seen; best effort, never blocks a request. */
  touch(deviceId) {
    const record = this.#devices.get(deviceId)
    if (record === undefined) return
    const now = Date.now()
    // Rewrite the file at most once an hour, so ordinary traffic stays off disk.
    if (now - (record.lastSeenAt ?? 0) < 60 * 60 * 1000) return
    record.lastSeenAt = now
    void this.#persist().catch(() => undefined)
  }

  /** Every paired device, newest first, for the operator's list. */
  list() {
    return [...this.#devices.values()].sort((left, right) => right.issuedAt - left.issuedAt)
  }

  /**
   * Revoke one device. Its cookie stops working immediately because `verify`
   * requires the record to exist.
   */
  async revoke(deviceId) {
    await this.#ensureLoaded()
    const deleted = this.#devices.delete(deviceId)
    if (deleted) {
      // Revoking the primary hands the role to the longest-paired survivor rather
      // than leaving it empty — see #adoptOldestAsPrimary.
      if (this.#primaryDeviceId === deviceId) {
        this.#primaryDeviceId = null
        this.#adoptOldestAsPrimary()
      }
      await this.#persist()
    }
    return deleted
  }

  /** The `Set-Cookie` line for a freshly paired device. */
  static deviceCookie(value, expiresAt) {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    return `${DEVICE_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`
  }
}

/** Read one named cookie out of a raw `Cookie` header. */
export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}
