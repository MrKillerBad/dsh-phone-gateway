/**
 * A directory service confined to operator-approved roots.
 *
 * The phone may create a workspace, but it may NOT name an arbitrary path on the
 * host: a workspace is a filesystem scope for the agent, so allowing one would let
 * anyone holding the device cookie point the agent at any directory the computer's
 * user can read. Everything here exists to hold one boundary — the resolved real
 * path must stay inside a configured root.
 *
 * The containment test runs on `realpath`, not on the text the caller sent, so
 * `..` segments and symlinks are judged by where they actually land. On Windows that
 * also normalises drive-letter case, which makes a plain `startsWith` unusable.
 */

import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A label a phone may show for a root; the path itself never leaves the host. */
function labelOf(rootPath) {
  return rootPath
}

/**
 * Every filesystem root this machine has: the drive letters on Windows, `/` elsewhere.
 *
 * This is the default when the operator has not confined the picker. It is also what
 * makes the picker portable AND usable: a workspace can be created anywhere, the same
 * way the operating system's own folder dialog allows.
 *
 * @returns {Promise<string[]>} canonical root paths.
 */
export async function filesystemRoots() {
  if (process.platform === 'win32') {
    const drives = []
    for (let code = 65; code <= 90; code += 1) {
      const candidate = `${String.fromCharCode(code)}:\\`
      try {
        const info = await stat(candidate)
        if (info.isDirectory()) drives.push(candidate)
      } catch {
        // An unused letter or a drive with no media: not a usable root.
      }
    }
    if (drives.length > 0) return drives
  }
  return ['/']
}

/**
 * Keep only the configured entries that are absolute, exist, and are directories.
 *
 * An EMPTY configuration means "every drive": the operator chose to let the phone
 * browse the whole machine, matching what the native dialog offers.
 *
 * A typo or a removed drive must not take the picker down: unusable entries are
 * dropped and the rest still work.
 *
 * @param {unknown} configured - the `allowedWorkspaceRoots` config value.
 * @returns {Promise<string[]>} canonical absolute paths.
 */
export async function resolveRoots(configured) {
  const roots = []
  for (const entry of Array.isArray(configured) ? configured : []) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    const absolute = resolve(entry.trim())
    if (!isAbsolute(absolute)) continue
    try {
      const canonical = await realpath(absolute)
      const info = await stat(canonical)
      if (!info.isDirectory()) continue
      if (!roots.includes(canonical)) roots.push(canonical)
    } catch {
      // Missing or unreadable: skip it.
    }
  }
  if (roots.length > 0) return roots
  // Nothing configured (or every entry was unusable): fall back to the drives.
  return filesystemRoots()
}

/** Whether `child` is `parent` itself or lives beneath it. */
export function isInside(parent, child) {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** An error a caller may show verbatim; never carries a host path. */
function failure(code) {
  return { ok: false, error: code }
}

/**
 * Names Windows hides by default and Node cannot see the attribute for.
 *
 * `fs.readdir` reports every entry; the hidden/system bits live in the Win32 find
 * data, which Node does not surface. So the convention stands in for the attribute:
 * `$RECYCLE.BIN`, `$SysReset` and friends are all `$`-prefixed, and the two named
 * ones are the legacy junctions and the system restore store. A dot prefix covers
 * the same idea on other platforms.
 *
 * This is deliberately a short, explainable list rather than a guess at "systemy"
 * names: the picker also offers a switch to show everything.
 */
const HIDDEN_BY_CONVENTION = new Set(['System Volume Information', 'Documents and Settings'])

/** Whether an entry is hidden by the platform's naming convention. */
export function isHiddenEntry(name) {
  if (typeof name !== 'string' || name === '') return true
  if (HIDDEN_BY_CONVENTION.has(name)) return true
  return name.startsWith('$') || name.startsWith('.')
}

/**
 * Resolve one request to a real directory inside a root.
 *
 * @param {string[]} roots - canonical roots from {@link resolveRoots}.
 * @param {number} rootIndex - which root the request refers to.
 * @param {string} requestedPath - a relative path beneath that root, `''` for itself.
 * @returns {Promise<{ok: true, root: number, absolute: string, relative: string,
 *   entries: {name: string, path: string}[]}|{ok: false, error: string}>}
 */
export async function listDirectory(roots, rootIndex, requestedPath) {
  if (!Array.isArray(roots) || roots.length === 0) return failure('no-roots')
  if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= roots.length) {
    return failure('bad-root')
  }
  const rootPath = roots[rootIndex]
  const requested = typeof requestedPath === 'string' ? requestedPath : ''
  // A leading separator would make `join` discard the root entirely, and a drive
  // letter would name another volume. Both are absolute requests in disguise.
  if (isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) return failure('absolute-path')

  let absolute
  try {
    absolute = await realpath(join(rootPath, requested))
  } catch {
    return failure('not-found')
  }
  // The decisive check: a symlink or `..` that leaves the root fails here.
  if (!isInside(rootPath, absolute)) return failure('outside-root')

  let info
  try {
    info = await stat(absolute)
  } catch {
    return failure('not-found')
  }
  if (!info.isDirectory()) return failure('not-a-directory')

  let dirents
  try {
    dirents = await readdir(absolute, { withFileTypes: true })
  } catch {
    return failure('unreadable')
  }

  const entries = []
  for (const dirent of dirents) {
    // Directories only: a workspace is a directory, and this also keeps a phone
    // from probing whether an individual file exists.
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    // The recycle bin and the other system stores are directories Explorer hides;
    // offering them in a workspace picker only invites a mis-click.
    if (isHiddenEntry(dirent.name)) continue
    const childAbsolute = join(absolute, dirent.name)
    try {
      const childReal = await realpath(childAbsolute)
      const childInfo = await stat(childReal)
      if (!childInfo.isDirectory()) continue
      // A symlink pointing out of the root is hidden rather than shown-but-blocked.
      if (!isInside(rootPath, childReal)) continue
    } catch {
      continue
    }
    const childRelative = relative(rootPath, join(absolute, dirent.name)).split(sep).join('/')
    entries.push({ name: dirent.name, path: childRelative })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))

  const currentRelative = absolute === rootPath ? '' : relative(rootPath, absolute).split(sep).join('/')
  return { ok: true, root: rootIndex, absolute, relative: currentRelative, entries }
}

/**
 * Create one directory inside a root and return it as the chosen workspace.
 *
 * Only a single, plain name is accepted — no separators, no traversal, no drive.
 *
 * @param {string[]} roots - canonical roots.
 * @param {number} rootIndex - which root to create in.
 * @param {string} requestedPath - the parent directory, relative to the root.
 * @param {string} name - the new folder's name.
 * @returns {Promise<{ok: true, path: string}|{ok: false, error: string}>}
 */
export async function createDirectory(roots, rootIndex, requestedPath, name) {
  if (!Array.isArray(roots) || roots.length === 0) return failure('no-roots')
  if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= roots.length) {
    return failure('bad-root')
  }
  const rootPath = roots[rootIndex]
  const requested = typeof requestedPath === 'string' ? requestedPath : ''
  if (isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) return failure('absolute-path')

  const wanted = typeof name === 'string' ? name.trim() : ''
  if (wanted === '') return failure('bad-name')
  // `..`, `a/b`, `a\b` and a drive letter are all rejected here rather than later.
  if (wanted === '.' || wanted === '..') return failure('bad-name')
  if (/[\\/]/.test(wanted) || /^[a-zA-Z]:/.test(wanted)) return failure('bad-name')
  // Windows also forbids these characters outright; rejecting them yields a clear
  // error instead of an EINVAL from the filesystem.
  if (/[\u0000-\u001f<>:"|?*]/.test(wanted)) return failure('bad-name')

  let parent
  try {
    parent = await realpath(join(rootPath, requested))
  } catch {
    return failure('not-found')
  }
  if (!isInside(rootPath, parent)) return failure('outside-root')

  const target = join(parent, wanted)
  if (!isInside(rootPath, target)) return failure('outside-root')

  try {
    await mkdir(target)
  } catch (error) {
    if (error?.code === 'EEXIST') return failure('exists')
    return failure('create-failed')
  }

  // Verify what was actually created, not what was intended.
  try {
    const createdReal = await realpath(target)
    if (!isInside(rootPath, createdReal)) return failure('outside-root')
    return { ok: true, path: relative(rootPath, createdReal).split(sep).join('/') }
  } catch {
    return failure('create-failed')
  }
}

/**
 * The payload the client picker starts from.
 *
 * @param {string[]} roots - canonical roots.
 * @returns {{roots: {index: number, label: string}[], empty: boolean}}
 */
export function describeRoots(roots) {
  return {
    roots: roots.map((path, index) => ({ index, label: labelOf(path) })),
    empty: roots.length === 0,
  }
}
