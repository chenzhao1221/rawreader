/**
 * Constants of the Chrome extension bridge shared by main and the tests. The extension keeps its own copy of
 * the port list (extension/src/lib/bridge/protocol.ts); the two must stay equal.
 */

/** ID of the RawReader extension. Fixed by the `key` in extension/extension-key.json (checked by a unit test). */
export const BRIDGE_EXTENSION_ID = 'gpkjhmgphgimhomimgpjbdehibhenlce'

/** The only Origin the bridge accepts. */
export const BRIDGE_ALLOWED_ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}`

/** Default port of the bridge on 127.0.0.1. */
export const DEFAULT_BRIDGE_PORT = 18793

/** Ports tried in order when the previous one is taken. The extension probes the same list. */
export const BRIDGE_PORTS: readonly number[] = [18793, 18794, 18795, 18796, 18797]
