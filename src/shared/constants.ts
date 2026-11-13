/** Persistent Electron session partition used by the built-in browser. Contains no product name. */
export const BROWSE_PARTITION = 'persist:browse'

/** Height in CSS pixels of the tab strip above the toolbar. Must match the renderer layout. */
export const TAB_STRIP_HEIGHT = 34

/** Height in CSS pixels of the shell toolbar. Must match the renderer layout. */
export const TOOLBAR_HEIGHT = 48

/** Everything above the browse view: tab strip plus toolbar. */
export const TOP_CHROME_HEIGHT = TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT

/** Height of the "translate this page?" bar under the toolbar, while it is shown. */
export const INFOBAR_HEIGHT = 36

/** Most tabs kept open (and restored on start). */
export const MAX_TABS = 30

/** Height in CSS pixels of the shell status bar. Must match the renderer layout. */
export const STATUS_HEIGHT = 24

/** Loopback address every llama-server instance binds to. Never configurable. */
export const LLAMA_HOST = '127.0.0.1'
