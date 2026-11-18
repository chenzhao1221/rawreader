/**
 * Channel names as plain strings, with no zod import. Preload scripts import
 * only this file at runtime, so they stay tiny and standalone (sandbox).
 * `contract.ts` declares the payload schema for each name and is checked
 * against these lists at compile time.
 */

/** Renderer to main request/response channels (ipcRenderer.invoke). */
export const INVOKE_CHANNELS = [
  'browse:navigate',
  'browse:go',
  'shell:panel-visibility',
  'tabs:get',
  'tabs:new',
  'tabs:close',
  'tabs:activate',
  'webtext:page',
  'webtext:translate',
  'webtext:done',
  'webtext:bar',
  'webtext:bar-action',
  'secrets:status',
  'secrets:set',
  'config:get',
  'config:update',
  'llama:status',
  'llama:control',
  'app:open-logs',
  'page:hello',
  'page:images',
  'overlay:font',
  'cache:stats',
  'cache:clear',
  'models:overview',
  'models:download',
  'models:pick-folder',
  'models:locate-folder',
  'models:pick-file',
  'models:use-file',
  'models:clear-path',
  'system:info',
  'cuda:status',
  'cuda:download',
  'licenses:get',
  'bridge:status',
] as const

/** Main to renderer push events (webContents.send). */
export const EVENT_CHANNELS = [
  'browse:state',
  'tabs:state',
  'shell:focus-address',
  'webtext:command',
  'webtext:bar',
  'config:changed',
  'llama:status',
  'shell:notice',
  'page:config',
  'pipeline:progress',
  'overlay:result',
  'models:changed',
  'cuda:changed',
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(value)
}

export function isEventChannel(value: unknown): value is EventChannel {
  return typeof value === 'string' && (EVENT_CHANNELS as readonly string[]).includes(value)
}
