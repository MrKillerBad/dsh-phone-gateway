/**
 * Step 3 probe (live traffic): perform a real WebSocket handshake through the
 * gateway, answer DSH's ping, and report every frame that arrives.
 *
 * Run:  node tools/ws-live.mjs [gatewayOrigin]
 *
 * A 101 alone only proves the handshake was forwarded. This probe proves the
 * pipe is bidirectional: it sends masked pong frames for DSH's periodic ping,
 * then reports the opcodes and payload sizes that come back.
 */

import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'

const GATEWAY = process.argv[2] ?? 'http://127.0.0.1:8791'
const MUX_PATH = '/api/remote.mux'
const LISTEN_MS = 6000

const target = new URL(GATEWAY)
const key = randomBytes(16).toString('base64')
const socket = connect({ host: target.hostname, port: Number(target.port) })

await new Promise((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})

socket.write(
  [
    `GET ${MUX_PATH} HTTP/1.1`,
    `Host: ${target.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
    `Origin: ${target.origin}`,
    'Cookie: dsh-auth=through-gateway',
    '',
    '',
  ].join('\r\n'),
)

/** Buffered reader over the socket once the handshake head is consumed. */
let buffer = Buffer.alloc(0)
const frames = []

function takeFrame() {
  if (buffer.length < 2) return undefined
  const first = buffer[0]
  const second = buffer[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    length = Number(big)
    offset = 10
  }
  const maskBytes = masked ? 4 : 0
  if (buffer.length < offset + maskBytes + length) return undefined

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
  const start = offset + maskBytes
  const payload = Buffer.from(buffer.subarray(start, start + length))
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  }
  buffer = buffer.subarray(start + length)
  return { fin, opcode, payload }
}

/** Send one masked frame from this client. */
function sendFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4)
  const body = Buffer.from(payload)
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4]
  const lengthByte = body.length < 126 ? body.length : 126
  const header = Buffer.from([0x80 | opcode, 0x80 | lengthByte])
  const ext = body.length < 126 ? Buffer.alloc(0) : (() => {
    const out = Buffer.alloc(2)
    out.writeUInt16BE(body.length)
    return out
  })()
  socket.write(Buffer.concat([header, ext, mask, body]))
}

const head = await new Promise((resolve, reject) => {
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    socket.off('data', onData)
    resolve(buffer.subarray(0, end).toString('latin1'))
    buffer = buffer.subarray(end + 4)
  }
  socket.on('error', reject)
  socket.on('data', onData)
})

console.log('handshake:', head.split('\r\n')[0])

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (let frame = takeFrame(); frame !== undefined; frame = takeFrame()) {
    frames.push({ opcode: frame.opcode, bytes: frame.payload.length, fin: frame.fin })
    if (frame.opcode === 0x9) sendFrame(0xa, frame.payload) // ping → pong
  }
})

await new Promise((resolve) => setTimeout(resolve, LISTEN_MS))
socket.destroy()

const opcodeName = { 0x1: 'text', 0x2: 'binary', 0x8: 'close', 0x9: 'ping', 0xa: 'pong' }
console.log(
  JSON.stringify(
    {
      handshakeStatus: head.split('\r\n')[0],
      framesReceived: frames.length,
      byOpcode: frames.map((frame) => `${opcodeName[frame.opcode] ?? frame.opcode}(${frame.bytes}B)`),
    },
    null,
    2,
  ),
)
