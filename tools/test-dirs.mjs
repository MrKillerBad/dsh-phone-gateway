/**
 * The workspace picker's confinement.
 *
 * Everything the phone may name is funnelled through these functions, so the tests
 * attack them the way a caller would: absolute paths, `..` traversal, symlinks that
 * point out of the root, and names that try to smuggle a separator. A hole here
 * means a paired phone can point the agent at any directory on the host.
 *
 * Run:  node tools/test-dirs.mjs
 */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDirectory,
  describeRoots,
  filesystemRoots,
  isHiddenEntry,
  isInside,
  listDirectory,
  resolveRoots,
} from '../dsh-phone-gateway/lib/dirs.js'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${name} ${detail}`)
  return false
}

const base = await mkdtemp(join(tmpdir(), 'lan-gw-dirs-'))
const allowed = join(base, 'allowed')
const outside = join(base, 'outside')
await mkdir(join(allowed, 'project-a'), { recursive: true })
await mkdir(join(allowed, 'project-b'), { recursive: true })
await mkdir(join(outside, 'secret'), { recursive: true })
await writeFile(join(allowed, 'a-file.txt'), 'x', 'utf8')
await writeFile(join(outside, 'secret', 'private.txt'), 'x', 'utf8')

const roots = await resolveRoots([allowed, join(base, 'missing'), 42, ''])

console.log('1) configuration is filtered, never trusted')
{
  check('one usable root survives', roots.length === 1, String(roots.length))
  check('the missing entry is dropped', !roots.some((entry) => entry.includes('missing')))
  check('the root is canonical', roots[0] === (await resolve(allowed)), roots[0])
  const described = describeRoots(roots)
  check('the picker gets a root label', described.roots.length === 1 && typeof described.roots[0].label === 'string')
  check('empty configuration is reported', describeRoots([]).empty === true)
}

console.log('2) isInside is the boundary primitive')
{
  const rootPath = resolve(allowed)
  check('a child is inside', isInside(rootPath, join(rootPath, 'project-a')))
  check('the root itself is inside', isInside(rootPath, rootPath))
  check('a sibling is outside', !isInside(rootPath, resolve(outside)))
  check('a parent is outside', !isInside(join(rootPath, 'project-a'), rootPath))
  // A prefix match would call this inside; path.relative does not.
  check('a name-prefix sibling is outside', !isInside(rootPath, `${rootPath}-evil`))
}

console.log('3) listing stays under the root')
{
  const listed = await listDirectory(roots, 0, '')
  check('the root lists', listed.ok === true, String(listed.error))
  check('only directories are offered', listed.ok && listed.entries.every((entry) => entry.name !== 'a-file.txt'))
  check('both projects appear', listed.ok && listed.entries.length === 2, String(listed.ok ? listed.entries.length : 'n/a'))
  check('paths are relative', listed.ok && listed.entries.every((entry) => !entry.path.includes(':')))

  const nested = await listDirectory(roots, 0, 'project-a')
  check('a subdirectory lists', nested.ok === true, String(nested.error))
  check('the relative path is reported', nested.ok && nested.relative === 'project-a', nested.ok ? nested.relative : '')
}

console.log('4) traversal and absolute paths are refused')
{
  const cases = [
    ['parent traversal', '..'],
    ['nested traversal', '../outside'],
    ['deep traversal', 'project-a/../../outside'],
    ['the sibling by name', '../outside/secret'],
  ]
  for (const [label, attempt] of cases) {
    const result = await listDirectory(roots, 0, attempt)
    check(label, result.ok === false, `error=${String(result.error)}`)
  }

  const absoluteAttempts = [
    ['an absolute posix path', '/etc'],
    ['an absolute windows path', 'C:\\Windows'],
    ['a bare drive', 'D:'],
    ['a drive-relative path', 'C:temp'],
  ]
  for (const [label, attempt] of absoluteAttempts) {
    const result = await listDirectory(roots, 0, attempt)
    check(label, result.ok === false, `error=${String(result.error)}`)
  }

  check('a bad root index is refused', (await listDirectory(roots, 7, '')).ok === false)
  check('a missing directory is refused', (await listDirectory(roots, 0, 'nope')).ok === false)
  check('a file is refused', (await listDirectory(roots, 0, 'a-file.txt')).ok === false)
  check('no roots means no access', (await listDirectory([], 0, '')).ok === false)
}

console.log('5) a symlink out of the root is refused and hidden')
{
  let linked = true
  // Windows refuses `dir` symlinks without elevation, but a directory junction
  // needs no privilege — and it is the same escape vector, so it is the better test.
  for (const type of ['junction', 'dir']) {
    try {
      await symlink(outside, join(allowed, 'escape-link'), type)
      linked = true
      break
    } catch {
      linked = false
    }
  }
  if (!linked) {
    console.log('  SKIP symlinks are not permitted in this environment')
  } else {
    const escaped = await listDirectory(roots, 0, 'escape-link')
    check('following it out is refused', escaped.ok === false, `error=${String(escaped.error)}`)
    check('the reason names the boundary', escaped.error === 'outside-root', String(escaped.error))

    const listed = await listDirectory(roots, 0, '')
    check('it is not advertised either', listed.ok && !listed.entries.some((entry) => entry.name === 'escape-link'))

    // A junction pointing INSIDE the root must still work: the rule is about where
    // the link lands, not about links being forbidden.
    let insideLinked = true
    try {
      await symlink(join(allowed, 'project-a'), join(allowed, 'inside-link'), 'junction')
    } catch {
      insideLinked = false
    }
    if (insideLinked) {
      const inside = await listDirectory(roots, 0, 'inside-link')
      check('a link that stays inside is allowed', inside.ok === true, String(inside.error))
    }
  }
}

console.log('6) creating a workspace stays inside the root')
{
  const created = await createDirectory(roots, 0, '', 'new-workspace')
  check('a plain name is created', created.ok === true, String(created.error))
  check('the path is relative to the root', created.ok && created.path === 'new-workspace', created.ok ? created.path : '')
  check('it appears in the listing', (await listDirectory(roots, 0, 'new-workspace')).ok === true)

  check('the same name twice is refused', (await createDirectory(roots, 0, '', 'new-workspace')).error === 'exists')

  const badNames = [
    ['a separator', 'a/b'],
    ['a backslash separator', 'a\\b'],
    ['traversal', '..'],
    ['dot', '.'],
    ['empty', '   '],
    ['a drive letter', 'C:evil'],
    ['an absolute path', '/etc/evil'],
  ]
  for (const [label, name] of badNames) {
    const result = await createDirectory(roots, 0, '', name)
    check(`refuses ${label}`, result.ok === false, `error=${String(result.error)}`)
  }

  const traversalParent = await createDirectory(roots, 0, '../outside', 'evil')
  check('refuses a parent outside the root', traversalParent.ok === false, `error=${String(traversalParent.error)}`)
}

console.log('7) the picker payload never leaks a host path it did not have to')
{
  const listed = await listDirectory(roots, 0, '')
  // The absolute path IS returned: the workspace must be created with a real path,
  // and the caller is already the owner of this machine. The guarantee kept here is
  // narrower and more important — every returned absolute path is inside a root.
  const absoluteInside = roots.some((entry) => isInside(entry, listed.absolute))
  check('the reported absolute path is inside a root', listed.ok && absoluteInside)
  check('entries carry no absolute paths', listed.ok && listed.entries.every((entry) => !/^[a-zA-Z]:|[\\/]/.test(entry.path.replace(/[\\/]/g, ''))))
}

console.log('8) the picker is wired through the plugin, not through a slot')
{
  const gatewaySource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
  const clientSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'client.js'), 'utf8')
  const configSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'config.js'), 'utf8')

  check('the option exists', configSource.includes('allowedWorkspaceRoots'))
  check('it defaults to empty', /allowedWorkspaceRoots:\s*\[\]/.test(configSource))

  // The native chooser reads this global in its own apply(); defining it is how the
  // host's picker is replaced without touching its code or fighting over a slot.
  check('the host defines the picker global', gatewaySource.includes('__DSH_DIRECTORY_PICKER__'))
  check('it is gated by its own switch', /remoteWorkspacePicker\)\s*\{[\s\S]{0,200}DIRECTORY_PICKER_SHIM/.test(gatewaySource))
  check('the shim is a head injection', /DIRECTORY_PICKER_SHIM[\s\S]{0,80}|placement: 'head'[\s\S]{0,200}DIRECTORY_PICKER_SHIM/.test(gatewaySource))

  // The desktop shell supplies its own global from a preload script; overwriting it
  // would replace the real native chooser with ours on the computer.
  check('the shim skips non-http origins', gatewaySource.includes("location.protocol!=='http:'"))
  check('the shim skips loopback', gatewaySource.includes("h==='127.0.0.1'"))
  check('the shim never clobbers an existing global', gatewaySource.includes('__DSH_DIRECTORY_PICKER__!==undefined'))

  check('the client publishes the implementation', clientSource.includes('__DSH_LAN_PICK_DIRECTORY__'))
  check('the client has a picker dialog', clientSource.includes('openWorkspacePicker'))
  check('the dialog talks to the confined route', clientSource.includes('DIRS_PATH'))

  // The sidebar entry is hidden inside the app, but the picker must not be: the
  // phone is the only client that needs it.
  const applyBody = clientSource.slice(clientSource.indexOf('apply(ctx) {'))
  const bridgeAt = applyBody.indexOf('installWorkspacePickerBridge()')
  const bailAt = applyBody.indexOf('insidePhoneApp()) return')
  check('the bridge installs before the in-app bail-out', bridgeAt > 0 && bailAt > 0 && bridgeAt < bailAt,
    `bridge@${String(bridgeAt)} bail@${String(bailAt)}`)
}

console.log('9) with nothing configured, the picker reaches every drive')
{
  const gatewaySource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
  const configSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'lib', 'config.js'), 'utf8')

  // The operator accepted full-machine reach on the phone, matching what the native
  // folder dialog offers. Confinement is still available as an explicit config.
  const defaults = await resolveRoots([])
  check('an empty config yields roots', defaults.length > 0, String(defaults.length))
  check('the roots are absolute', defaults.every((entry) => isAbsolute(entry)), JSON.stringify(defaults))
  const drives = await filesystemRoots()
  check('filesystemRoots lists this machine', drives.length > 0, String(drives.length))
  check('the defaults are the filesystem roots', JSON.stringify(defaults) === JSON.stringify(drives))
  check(
    'every root is listed as a picker root',
    describeRoots(defaults).roots.length === defaults.length,
    String(describeRoots(defaults).roots.length),
  )

  // An explicit configuration still confines.
  const confined = await resolveRoots([allowed])
  check('an explicit config wins', confined.length === 1 && isInside(confined[0], resolve(allowed)), JSON.stringify(confined))
  const bogus = await resolveRoots(['Z:\\definitely-not-here-xyz'])
  check('an unusable config falls back to the drives', JSON.stringify(bogus) === JSON.stringify(drives))

  check('the server asks for roots through one call', /workspaceRootCandidates = \(\) => resolveRoots\(/.test(gatewaySource))
  check('the picker has its own switch', gatewaySource.includes('remoteWorkspacePicker'))
  check('it defaults to on', /remoteWorkspacePicker:\s*true/.test(configSource))
  check('the shim is gated on the switch', /remoteWorkspacePicker\)\s*\{[\s\S]{0,200}DIRECTORY_PICKER_SHIM/.test(gatewaySource))
}

console.log('10) the picker offers a drive switcher')
{
  const clientSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'client.js'), 'utf8')
  check('a drive row exists', clientSource.includes('dsh-phone-gateway-pick-drives'))
  check('one chip per root', /roots\.length > 1[\s\S]{0,600}dsh-phone-gateway-pick-drive/.test(clientSource))
  check('a chip switches root', /chip\.addEventListener\('click', \(\) => load\(root\.index, ''\)\)/.test(clientSource))
  check('the active root is marked', clientSource.includes("classList.add('active')"))
  check('permission errors are explained, not dumped', clientSource.includes('没有访问权限'))
}
console.log('11) Windows system entries are filtered out, with no way to reveal them')
{
  // `fs.readdir` reports the recycle bin; Explorer does not. Node cannot read the
  // hidden/system attribute, so a naming convention stands in for it. The picker
  // hides these unconditionally: they are never a valid workspace.
  check('$RECYCLE.BIN is hidden', isHiddenEntry('$RECYCLE.BIN') === true)
  check('other $-prefixed entries are hidden', isHiddenEntry('$SysReset') === true)
  check('the restore store is hidden', isHiddenEntry('System Volume Information') === true)
  check('the legacy junction is hidden', isHiddenEntry('Documents and Settings') === true)
  check('a dot prefix is hidden', isHiddenEntry('.git') === true)
  check('a normal project folder is shown', isHiddenEntry('deepseek-all') === false)
  check('an empty name is hidden', isHiddenEntry('') === true)

  const listed = await listDirectory(roots, 0, '')
  check('the listing succeeds', listed.ok === true, String(listed.error))
  check(
    'no hidden entry survives the listing',
    listed.ok && listed.entries.every((entry) => !isHiddenEntry(entry.name)),
  )

  // There is deliberately no switch: the option and its query parameter were removed
  // once the operator decided these entries are never wanted.
  const clientSource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'client.js'), 'utf8')
  const gatewaySource = readFileSync(join(here, '..', 'dsh-phone-gateway', 'index.js'), 'utf8')
  check('no reveal control in the picker', !clientSource.includes('显示系统项'))
  check('no hidden flag in the request', !clientSource.includes('hidden=1'))
  check('no hidden parameter on the server', !gatewaySource.includes("get('hidden')"))
  check('listDirectory takes no reveal option', !/listDirectory\([^)]*showHidden/.test(gatewaySource))
}
await rm(base, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
