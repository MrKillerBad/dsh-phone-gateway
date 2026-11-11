/**
 * A minimal QR Code encoder — byte mode, error-correction level L or M, versions
 * 1..10.
 *
 * Why hand-written: the gateway resolves its dependencies from its own directory,
 * and this package has none. The offline environment has no registry either, so a
 * library is not an option. The surface is deliberately small — the only payload
 * is a URL of ~40 bytes — which keeps the tables and the error-correction math
 * auditable.
 *
 * Correctness is not asserted by inspection: `tools/test-qr.mjs` compares the
 * produced matrix, module for module, against the well-tested `qrcode` package
 * that ships inside this profile (used only as a test oracle, never at runtime).
 *
 * Reference: ISO/IEC 18004:2015, QR Code Model 2.
 */

/** Galois-field tables for GF(256) with the QR polynomial 0x11D. */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value
    LOG[value] = index
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255]
}

function gfMul(left, right) {
  if (left === 0 || right === 0) return 0
  return EXP[LOG[left] + LOG[right]]
}


/**
 * Error-correction layout per version and level:
 * `[ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]`.
 */
const EC_BLOCKS = {
  L: [
    null,
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
}

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** Number of bits the character-count field uses for byte mode. */
function charCountBits(version) {
  return version < 10 ? 8 : 16
}

/** Bit length of a positive integer. */
function bitLength(value) {
  let length = 0
  let rest = value
  while (rest !== 0) {
    length += 1
    rest >>>= 1
  }
  return length
}

/** BCH(15,5) format information, XORed with the mandated mask. */
function formatInformation(ecBits, mask) {
  const data = (ecBits << 3) | mask
  let divisor = data << 10
  while (bitLength(divisor) >= 11) divisor ^= 0x537 << (bitLength(divisor) - 11)
  return ((data << 10) | divisor) ^ 0x5412
}

/** BCH(18,6) version information (versions 7 and up). */
function versionInformation(version) {
  let divisor = version << 12
  while (bitLength(divisor) >= 13) divisor ^= 0x1f25 << (bitLength(divisor) - 13)
  return (version << 12) | divisor
}

/** EC level → the two-bit value the format field carries. */
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 }

/** Reed-Solomon generator polynomial of the given degree. */
function generatorPolynomial(degree) {
  let poly = [1]
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let term = 0; term < poly.length; term += 1) {
      next[term] ^= poly[term]
      next[term + 1] ^= gfMul(poly[term], EXP[index])
    }
    poly = next
  }
  return poly
}

/** Error-correction codewords for one block of data codewords. */
function reedSolomon(data, ecLength) {
  const generator = generatorPolynomial(ecLength)
  const remainder = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecLength - 1] = 0
    if (factor !== 0) {
      for (let index = 0; index < ecLength; index += 1) {
        remainder[index] ^= gfMul(generator[index + 1], factor)
      }
    }
  }
  return remainder
}

/** Append `length` bits of `value` (MSB first) to `bits`. */
function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push((value >>> index) & 1)
  }
}

/** The smallest version whose data capacity holds `byteLength` bytes. */
function chooseVersion(byteLength, level) {
  for (let version = 1; version <= 10; version += 1) {
    const layout = EC_BLOCKS[level][version]
    const dataCodewords = layout[1] * layout[2] + layout[3] * layout[4]
    const capacityBits = dataCodewords * 8
    const neededBits = 4 + charCountBits(version) + byteLength * 8
    if (neededBits <= capacityBits) return version
  }
  throw new Error(`qr: payload too large for version 10 at level ${level}`)
}

/** The final interleaved codeword sequence (data + error correction). */
function buildCodewords(bytes, version, level) {
  const layout = EC_BLOCKS[level][version]
  const [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] = layout
  const totalData = group1Blocks * group1Data + group2Blocks * group2Data

  const bits = []
  appendBits(bits, 0b0100, 4) // byte mode
  appendBits(bits, bytes.length, charCountBits(version))
  for (const byte of bytes) appendBits(bits, byte, 8)

  // Terminator, then pad to a byte boundary.
  const capacityBits = totalData * 8
  for (let index = 0; index < 4 && bits.length < capacityBits; index += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataCodewords = new Uint8Array(totalData)
  for (let index = 0; index < totalData; index += 1) {
    let byte = 0
    for (let offset = 0; offset < 8; offset += 1) {
      byte = (byte << 1) | (bits[index * 8 + offset] ?? 0)
    }
    dataCodewords[index] = byte
  }
  // Pad codewords alternate EC / 11 until the capacity is filled.
  for (let index = bits.length / 8, pad = 0; index < totalData; index += 1, pad += 1) {
    dataCodewords[index] = pad % 2 === 0 ? 0xec : 0x11
  }

  // Split into blocks, compute EC per block, then interleave both sequences.
  const blocks = []
  let cursor = 0
  for (let index = 0; index < group1Blocks; index += 1) {
    const chunk = dataCodewords.subarray(cursor, cursor + group1Data)
    cursor += group1Data
    blocks.push({ data: chunk, ec: reedSolomon(chunk, ecPerBlock) })
  }
  for (let index = 0; index < group2Blocks; index += 1) {
    const chunk = dataCodewords.subarray(cursor, cursor + group2Data)
    cursor += group2Data
    blocks.push({ data: chunk, ec: reedSolomon(chunk, ecPerBlock) })
  }

  const maxData = Math.max(...blocks.map((block) => block.data.length))
  const out = []
  for (let index = 0; index < maxData; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) out.push(block.data[index])
    }
  }
  for (let index = 0; index < ecPerBlock; index += 1) {
    for (const block of blocks) out.push(block.ec[index])
  }
  return Uint8Array.from(out)
}

/** Draw one 7×7 finder pattern plus its separator at (top, left). */
function drawFinder(matrix, size, top, left) {
  for (let row = -1; row <= 7; row += 1) {
    for (let col = -1; col <= 7; col += 1) {
      const y = top + row
      const x = left + col
      if (y < 0 || y >= size || x < 0 || x >= size) continue
      const inside = row >= 0 && row <= 6 && col >= 0 && col <= 6
      const dark =
        inside &&
        (row === 0 || row === 6 || col === 0 || col === 6 ||
          (row >= 2 && row <= 4 && col >= 2 && col <= 4))
      matrix[y][x] = dark ? 1 : 0
    }
  }
}

/** Draw one 5×5 alignment pattern centred at (cy, cx). */
function drawAlignment(matrix, cy, cx) {
  for (let row = -2; row <= 2; row += 1) {
    for (let col = -2; col <= 2; col += 1) {
      const dark =
        Math.max(Math.abs(row), Math.abs(col)) !== 1
      matrix[cy + row][cx + col] = dark ? 1 : 0
    }
  }
}

/** One of the eight mask predicates; `true` means "invert this module". */
function maskAt(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return false
  }
}

/** Penalty score of a finished matrix (the spec's four rules). */
function penalty(matrix, size) {
  let score = 0

  // Rule 1: runs of five or more same-colour modules.
  const runScore = (line) => {
    let total = 0
    let run = 1
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) {
        run += 1
      } else {
        if (run >= 5) total += run - 2
        run = 1
      }
    }
    if (run >= 5) total += run - 2
    return total
  }
  for (let row = 0; row < size; row += 1) {
    score += runScore(matrix[row])
    const column = []
    for (let col = 0; col < size; col += 1) column.push(matrix[col][row])
    score += runScore(column)
  }

  // Rule 2: every 2×2 block of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const first = matrix[row][col]
      if (
        first === matrix[row][col + 1] &&
        first === matrix[row + 1][col] &&
        first === matrix[row + 1][col + 1]
      ) {
        score += 3
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const matches = (line) => {
    let total = 0
    for (let start = 0; start + 11 <= line.length; start += 1) {
      let hitA = true
      let hitB = true
      for (let offset = 0; offset < 11; offset += 1) {
        if (line[start + offset] !== patternA[offset]) hitA = false
        if (line[start + offset] !== patternB[offset]) hitB = false
      }
      if (hitA) total += 40
      if (hitB) total += 40
    }
    return total
  }
  for (let row = 0; row < size; row += 1) {
    score += matches(matrix[row])
    const column = []
    for (let col = 0; col < size; col += 1) column.push(matrix[col][row])
    score += matches(column)
  }

  // Rule 4: deviation of the dark-module ratio from 50%.
  let dark = 0
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (matrix[row][col] === 1) dark += 1
  }
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * Encode `text` as a QR Code.
 *
 * @param {string} text - UTF-8 payload.
 * @param {{ecLevel?: 'L'|'M'}} [options] - error-correction level, default M.
 * @returns {{version: number, size: number, modules: number[][]}} a row-major
 * matrix of 0/1 with no quiet zone.
 */
export function encodeQr(text, options = {}) {
  const level = options.ecLevel ?? 'M'
  if (EC_BLOCKS[level] === undefined) throw new Error(`qr: unsupported level ${level}`)

  const bytes = Buffer.from(String(text), 'utf8')
  const version = chooseVersion(bytes.length, level)
  const size = 17 + version * 4
  const codewords = buildCodewords(bytes, version, level)
  const dataBits = []
  for (const byte of codewords) appendBits(dataBits, byte, 8)

  const buildMatrix = (mask) => {
    // null marks an unset (data) module; function patterns are 0/1.
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null))

    drawFinder(matrix, size, 0, 0)
    drawFinder(matrix, size, 0, size - 7)
    drawFinder(matrix, size, size - 7, 0)

    const positions = ALIGNMENT[version]
    for (let index = 0; index < positions.length; index += 1) {
      for (let other = 0; other < positions.length; other += 1) {
        const skip =
          (index === 0 && other === 0) ||
          (index === 0 && other === positions.length - 1) ||
          (index === positions.length - 1 && other === 0)
        if (skip) continue
        drawAlignment(matrix, positions[index], positions[other])
      }
    }

    for (let index = 8; index < size - 8; index += 1) {
      const bit = index % 2 === 0 ? 1 : 0
      if (matrix[6][index] === null) matrix[6][index] = bit
      if (matrix[index][6] === null) matrix[index][6] = bit
    }

    // Reserve the format-info areas so data placement skips them.
    const reserve = (row, col) => {
      if (matrix[row][col] === null) matrix[row][col] = 0
    }
    for (let index = 0; index < 9; index += 1) {
      if (index !== 6) reserve(8, index)
      if (index !== 6) reserve(index, 8)
    }
    for (let index = 0; index < 8; index += 1) reserve(size - 1 - index, 8)
    for (let index = 0; index < 8; index += 1) reserve(8, size - 1 - index)

    if (version >= 7) {
      for (let index = 0; index < 6; index += 1) {
        for (let other = 0; other < 3; other += 1) {
          reserve(index, size - 11 + other)
          reserve(size - 11 + other, index)
        }
      }
    }

    // Zig-zag placement of the data bits, two columns at a time.
    let bitIndex = 0
    let increment = -1
    let row = size - 1
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1
      for (;;) {
        for (let offset = 0; offset < 2; offset += 1) {
          const target = col - offset
          if (matrix[row][target] !== null) continue
          let bit = 0
          if (bitIndex < dataBits.length) bit = dataBits[bitIndex]
          bitIndex += 1
          matrix[row][target] = maskAt(mask, row, target) ? bit ^ 1 : bit
        }
        row += increment
        if (row < 0 || row >= size) {
          row -= increment
          increment = -increment
          break
        }
      }
    }

    // Format information, both copies, plus the always-dark module.
    const format = formatInformation(EC_BITS[level], mask)
    for (let index = 0; index < 15; index += 1) {
      const bit = (format >> index) & 1
      if (index < 6) matrix[index][8] = bit
      else if (index < 8) matrix[index + 1][8] = bit
      else matrix[size - 15 + index][8] = bit
    }
    for (let index = 0; index < 15; index += 1) {
      const bit = (format >> index) & 1
      if (index < 8) matrix[8][size - index - 1] = bit
      else if (index < 9) matrix[8][15 - index - 1 + 1] = bit
      else matrix[8][15 - index - 1] = bit
    }
    matrix[size - 8][8] = 1

    if (version >= 7) {
      const bits = versionInformation(version)
      for (let index = 0; index < 18; index += 1) {
        const bit = (bits >> index) & 1
        matrix[Math.floor(index / 3)][(index % 3) + size - 11] = bit
        matrix[(index % 3) + size - 11][Math.floor(index / 3)] = bit
      }
    }

    return matrix
  }

  // Pick the mask with the lowest penalty, the way every conformant encoder does.
  let best = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(mask)
    const score = penalty(candidate, size)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return { version, size, modules: best }
}

/**
 * The matrix as one string per row of `'0'`/`'1'`.
 *
 * Rows of characters, rather than a nested number array, keep the payload injected
 * into the page compact and trivial to render: a 29×29 code becomes 29 strings.
 *
 * @param {{modules: number[][]}} code - the object returned by {@link encodeQr}.
 * @returns {string[]} row strings, top to bottom.
 */
export function qrRows(code) {
  return code.modules.map((row) => row.map((cell) => (cell === 1 ? '1' : '0')).join(''))
}

/**
 * Render rows as standalone SVG markup, for the server-rendered pages.
 *
 * The colours are fixed black-on-white and are not themed: a QR code relies on
 * contrast to scan, so it must stay light-on-dark-theme-proof. A four-module quiet
 * zone is included because scanners reject a code that touches its own edge.
 *
 * @param {string[]} rows - as returned by {@link qrRows}.
 * @param {{moduleSize?: number, margin?: number, label?: string}} [options] - sizing.
 * @returns {string} an `<svg>` element.
 */
export function qrSvgMarkup(rows, options = {}) {
  const moduleSize = options.moduleSize ?? 4
  const margin = options.margin ?? 4
  const label = options.label ?? 'QR code'
  const size = rows.length
  const total = (size + margin * 2) * moduleSize

  // One path for every dark module: far smaller than one <rect> per module.
  let path = ''
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (rows[row][column] !== '1') continue
      const x = (column + margin) * moduleSize
      const y = (row + margin) * moduleSize
      path += `M${String(x)} ${String(y)}h${String(moduleSize)}v${String(moduleSize)}h-${String(moduleSize)}z`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(total)} ${String(total)}" ` +
    `width="${String(total)}" height="${String(total)}" role="img" aria-label="${escapeAttr(label)}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  )
}

/** Escape a value used inside a double-quoted HTML attribute. */
function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
