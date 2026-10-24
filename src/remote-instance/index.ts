/**
 * Public library boundary for the remote-instance capability.
 *
 * The openchamber extension service imports this module (esbuild inlines it
 * into one ESM bundle); the CLI uses the same functions directly. Keeping the
 * surface explicit here is what lets the service and the CLI share one
 * implementation without importing the whole host/transport stack.
 */

export {
  DEFAULT_APP_VERSION, DEFAULT_ENGINE_PIN, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT,
  NODE_RUNTIME, PROXY_DEFAULTS, RECONNECT_DEFAULTS,
  buildDesktopHandoff, buildForwardArgs, buildRelayForwardArgs, instanceIdFor, instancePaths,
  judgeEngineCompat, normalizeEngineVersion, parseTerminalProbe, quoteRemotePath, redactInstance,
} from '../core/remote-instance.js'
export type {
  DesktopHandoff, EngineCompatPayload, ForwardSpec, InstanceProxyConfig,
  RemoteInstance, TerminalProbe,
} from '../core/remote-instance.js'

export { createRemoteInstancesStore, remoteInstancesPath } from '../core/remote-instances.js'
export type { RemoteInstancesStore } from '../core/remote-instances.js'

export { createRemoteInstanceManager, instanceUrl, proxyConfig } from '../core/remote-instance-bridge.js'
export type {
  InstanceOutcome, InstancePlan, InstanceState, InstanceStatus, RemoteInstanceManager,
} from '../core/remote-instance-bridge.js'

export { createInstanceProxy } from '../core/remote-instance-proxy.js'
export type { InstanceProxy } from '../core/remote-instance-proxy.js'

export {
  defaultComponentSources, installPreparedComponent, pluginEntryFor, prepareComponent, registerPeerPlugins,
} from '../core/components.js'
export type { ComponentManifest, PreparedComponent } from '../core/components.js'

export {
  appPackManifestUrl, appPackName, appPackPath, appPackTierForGlibc,
  ensureAppPack, ensureAppPayload, ensureAppTree, parseAppPackManifest, provisionOffline, sshRun,
} from '../core/remote-instance-push.js'
export type { AppPackManifest, AppPackTier } from '../core/remote-instance-push.js'

export {
  latestPublishedPack, packReleaseAvailable, packReleaseAssets, parsePackReleases, compareSemver,
} from '../core/app-pack-registry.js'
export type { LatestPackResult, PublishedPack } from '../core/app-pack-registry.js'
