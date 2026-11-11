/**
 * Serves the Android app so a phone can install it before it can pair.
 *
 * Why this is public within the subnet: the app and the browser keep separate
 * cookie jars, so a phone that paired in its browser would still have to pair
 * again inside the app. Requiring authentication to download would therefore
 * make every first-time user pair twice. The file carries no credential — the
 * signing keystore is never packaged — so serving it to a same-subnet device
 * reveals only that this tool exists.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

/** Route serving the build. */
export const APP_PATH = '/__lan/app'

/** The build shipped inside the package, refreshed by android/build/build.ps1. */
export const DEFAULT_APP_FILE = join(PACKAGE_ROOT, 'assets', 'dsh-phone-gateway.apk')

/** Build metadata written beside the APK by build.ps1: `{ version, builtAt, size }`. */
const DEFAULT_META_FILE = join(PACKAGE_ROOT, 'assets', 'app.json')

/** The MIME an Android browser needs to hand the file to the package installer. */
export const APP_MIME = 'application/vnd.android.package-archive'

/**
 * Where the APK lives for this activation.
 * @param {object} config - resolved gateway configuration.
 * @returns {string} an absolute path.
 */
export function appFileOf(config) {
  const override = config?.appApkPath
  return typeof override === 'string' && override !== '' ? override : DEFAULT_APP_FILE
}

/**
 * Describe the download without opening it.
 *
 * A missing file is a normal state (the plugin can be installed before the app
 * is built), so it is reported rather than thrown: callers hide the download
 * entry instead of failing.
 *
 * @param {object} config - resolved gateway configuration.
 * @returns {Promise<object>} `{ available, path, size, etag, version, builtAt }`
 * or `{ available: false, reason }`.
 */
export async function describeApp(config) {
  const path = appFileOf(config)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return {
      available: false,
      reason: error?.code === 'ENOENT' ? 'not-built' : String(error?.message ?? error),
      path,
    }
  }
  if (!info.isFile() || info.size === 0) {
    return { available: false, reason: 'not-built', path }
  }

  // Build metadata is optional: the file is what matters, and a stale or missing
  // app.json must not make a present APK undownloadable.
  let version = null
  let builtAt = null
  try {
    const meta = JSON.parse(await readFile(DEFAULT_META_FILE, 'utf8'))
    version = typeof meta?.version === 'string' ? meta.version : null
    builtAt = typeof meta?.builtAt === 'string' ? meta.builtAt : null
  } catch {
    // Keep nulls.
  }

  return {
    available: true,
    path,
    size: info.size,
    etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    mtime: info.mtime.toISOString(),
    version,
    builtAt,
  }
}

/**
 * Stream the APK to a download response.
 *
 * @param {import('node:http').IncomingMessage} req - the request (for HEAD and If-None-Match).
 * @param {import('node:http').ServerResponse} res - the response to own to completion.
 * @param {object} app - the object returned by {@link describeApp}.
 * @param {string} [downloadName] - filename offered to the browser.
 * @returns {Promise<void>} resolves once the response is finished.
 */
export function sendApp(req, res, app, downloadName = 'dsh-phone-gateway.apk') {
  if (req.headers['if-none-match'] === app.etag) {
    res.writeHead(304, { etag: app.etag, 'cache-control': 'no-cache' })
    res.end()
    return Promise.resolve()
  }

  res.writeHead(200, {
    'content-type': APP_MIME,
    // A browser must offer to install rather than render; `attachment` is what
    // makes Android hand the bytes to the package installer.
    'content-disposition': `attachment; filename="${downloadName}"`,
    'content-length': String(app.size),
    'cache-control': 'no-cache',
    etag: app.etag,
  })

  if (req.method === 'HEAD') {
    res.end()
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const stream = createReadStream(app.path)
    stream.on('error', () => {
      // Headers are already out; the only honest ending is to drop the socket so
      // the browser reports a truncated download instead of a corrupt install.
      res.destroy()
      resolve()
    })
    res.on('close', () => {
      stream.destroy()
      resolve()
    })
    stream.pipe(res)
    stream.on('end', () => resolve())
  })
}
