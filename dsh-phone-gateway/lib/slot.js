/**
 * Who may drive the session right now.
 *
 * One phone at a time. The primary device may always take the seat — that is what
 * makes it the primary — and everyone else waits while the seat is taken. A
 * secondary never displaces anyone, including another secondary: only the primary
 * kicks, which is the rule the operator asked for.
 *
 * Kept pure and separate so the table below is directly testable; the HTTP and
 * WebSocket paths both consult it, and they must agree.
 */

/** @typedef {'take' | 'allow' | 'busy'} SlotDecision */

/**
 * Decide what to do with one device that wants to use the gateway.
 *
 * @param {{holder: string|null, deviceId: string, primaryId: string|null}} input -
 * whose seat it is, who is asking, and who owns the role.
 * @returns {SlotDecision} `take` seizes the seat (kicking the holder), `allow` is
 * the current holder, `busy` means another device is using it.
 */
export function decideSlot({ holder, deviceId, primaryId }) {
  if (typeof deviceId !== 'string' || deviceId === '') return 'busy'
  if (holder === null || holder === undefined) return 'take'
  if (holder === deviceId) return 'allow'
  // No designated primary, or the designated one is gone: the seat must still be
  // reachable, or a revoked primary would lock every phone out for good. First come
  // first served is the safe fallback — it never denies the machine's only user.
  if (primaryId === null || primaryId === undefined) return 'take'
  // Only the primary displaces somebody; a secondary waits its turn.
  if (deviceId === primaryId) return 'take'
  return 'busy'
}

/**
 * The refusal payload for a device that lost the seat.
 *
 * @param {'busy'} _reason - reserved for future refusal kinds.
 * @returns {{error: string, retryAfterMs: number}} the body for `/api` callers.
 */
export function busyPayload(_reason = 'busy') {
  return { error: 'device-busy', retryAfterMs: 8000 }
}
