/**
 * Dumps the reconstructed sidebar script so it can be syntax-checked directly.
 * Diagnostic aid for tools/test-sidebar-script.mjs.
 *
 * Run:  node tools/dump-sidebar-script.mjs [outPath]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'android', 'src', 'com', 'dsh', 'lan', 'MainActivity.java'), 'utf8')
const outPath = process.argv[2] ?? join(here, '_extracted.js')

function decodeJavaLiteral(raw) {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = raw[index + 1]
    index += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === '"') out += '"'
    else if (next === '\\') out += '\\'
    else if (next === 'u') {
      const hex = raw.slice(index + 1, index + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        index += 4
      } else {
        out += '\\u'
      }
    } else out += next
  }
  return out
}

function readConstant(name, resolve) {
  const start = source.indexOf(`String ${name} =`)
  if (start === -1) return undefined
  // CRLF source: `\n\n` would never match a blank line and the slice would run
  // to EOF, swallowing later methods.
  const terminator = /\r?\n\r?\n/.exec(source.slice(start))
  const end = terminator === null ? source.length : start + terminator.index
  const declaration = source.slice(start, end)

  let out = ''
  let index = 0
  while (index < declaration.length) {
    const char = declaration[index]

    if (char === '/' && declaration[index + 1] === '/') {
      const newline = declaration.indexOf('\n', index)
      index = newline === -1 ? declaration.length : newline + 1
      continue
    }
    if (char === '/' && declaration[index + 1] === '*') {
      const close = declaration.indexOf('*/', index)
      index = close === -1 ? declaration.length : close + 2
      continue
    }

    if (char === '"') {
      let cursor = index + 1
      let raw = ''
      while (cursor < declaration.length) {
        const inner = declaration[cursor]
        if (inner === '\\') {
          raw += inner + (declaration[cursor + 1] ?? '')
          cursor += 2
          continue
        }
        if (inner === '"') break
        raw += inner
        cursor += 1
      }
      out += decodeJavaLiteral(raw)
      index = cursor + 1
      continue
    }

    if (/[A-Za-z_]/.test(char)) {
      let cursor = index
      while (cursor < declaration.length && /[A-Za-z0-9_]/.test(declaration[cursor])) cursor += 1
      const identifier = declaration.slice(index, cursor)
      if (identifier !== 'String' && identifier !== name) {
        const replacement = resolve ? resolve(identifier) : undefined
        if (replacement !== undefined) out += replacement
      }
      index = cursor
      continue
    }

    index += 1
  }
  return out
}

const columnJs = readConstant('SIDEBAR_COLUMN_JS')
const handleJs = readConstant('SIDEBAR_HANDLE_SCRIPT', (id) => (id === 'SIDEBAR_COLUMN_JS' ? columnJs : undefined))

writeFileSync(outPath, handleJs, 'utf8')
console.log(`wrote ${handleJs.length} bytes to ${outPath}`)
