/**
 * Gateway configuration, with every default from the frozen design.
 *
 * The package is installed into the desktop profile as a linked directory, so
 * it resolves its dependencies from its own location and deliberately imports
 * nothing but `node:` builtins. That is also why the schema is a plain resolver
 * instead of a schemastery schema: the object is validated by hand here rather
 * than by pulling a package the link cannot resolve.
 */

/** Defaults from the design's Config table. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  port: 8791,
  bindAll: true,
  restrictSameSubnet: true,
  allowSubnets: [],
  injectMobileViewport: true,
  deviceTtlDays: 180,
  /** Empty means "the build shipped in this package". */
  appApkPath: '',
  /**
   * The only directories a phone may create a workspace in.
   *
   * Empty means "derive them from this machine": the parents of the registered
   * workspaces. That is what makes the plugin portable — a hardcoded path only
   * exists on the machine it was written for. Set this to tighten the boundary
   * deliberately.
   */
  allowedWorkspaceRoots: [],
  /** Turn the remote workspace picker off, restoring the host's native chooser. */
  remoteWorkspacePicker: true,
  /**
   * Mark the onboarding dialogs of known plugins as already seen on LAN origins.
   *
   * `localStorage` is scoped to an origin, and a LAN origin contains the machine's
   * address — which changes with the network. Every address change therefore looks
   * like a first visit, and those dialogs reappear on the phone each time.
   */
  hideLanWelcomeHints: true,
})

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asPort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}

function asSubnetList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
}

function asPath(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate one row's `config` into the object the gateway reads.
 * Unknown keys are dropped, and a malformed value falls back to its default
 * rather than failing activation: a typo in one field must not take the
 * listener — or DSH — down.
 *
 * @param {unknown} raw - the row's `config`, as loaded.
 * @returns {typeof DEFAULTS} the complete, validated configuration.
 */
export function resolveConfig(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  return {
    enabled: asBoolean(source.enabled, DEFAULTS.enabled),
    port: asPort(source.port, DEFAULTS.port),
    bindAll: asBoolean(source.bindAll, DEFAULTS.bindAll),
    restrictSameSubnet: asBoolean(source.restrictSameSubnet, DEFAULTS.restrictSameSubnet),
    allowSubnets: asSubnetList(source.allowSubnets),
    injectMobileViewport: asBoolean(source.injectMobileViewport, DEFAULTS.injectMobileViewport),
    deviceTtlDays: asPort(source.deviceTtlDays, DEFAULTS.deviceTtlDays),
    appApkPath: asPath(source.appApkPath),
    allowedWorkspaceRoots: asSubnetList(source.allowedWorkspaceRoots),
    remoteWorkspacePicker: asBoolean(source.remoteWorkspacePicker, DEFAULTS.remoteWorkspacePicker),
    hideLanWelcomeHints: asBoolean(source.hideLanWelcomeHints, DEFAULTS.hideLanWelcomeHints),
  }
}
