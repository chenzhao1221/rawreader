import { z } from 'zod'
import { ConfigPatchSchema, ConfigSchema } from '../config/schema'
import type { EventChannel, InvokeChannel } from './channels'

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

export const ServerRoleSchema = z.enum(['ocr', 'translate'])
export type ServerRole = z.infer<typeof ServerRoleSchema>

export const ServerStateSchema = z.enum(['stopped', 'starting', 'ready', 'stopping', 'error'])
export type ServerState = z.infer<typeof ServerStateSchema>

export const LlamaErrorCodeSchema = z.enum([
  'BINARY_MISSING',
  'MODEL_MISSING',
  'INVALID_CONFIG',
  'SPAWN_FAILED',
  'STARTUP_TIMEOUT',
  'EXITED',
  'CRASH_LOOP',
])
export type LlamaErrorCode = z.infer<typeof LlamaErrorCodeSchema>

export const ServerStatusSchema = z.object({
  role: ServerRoleSchema,
  state: ServerStateSchema,
  /** Port actually in use. Differs from the configured port after a free-port fallback. */
  port: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  errorCode: LlamaErrorCodeSchema.nullable(),
  /** Diagnostic detail in English (paths, exit codes). The UI maps `errorCode` to Chinese text. */
  message: z.string().nullable(),
})
export type ServerStatus = z.infer<typeof ServerStatusSchema>

export const NavRejectReasonSchema = z.enum(['empty', 'unsupported-scheme', 'invalid'])
export type NavRejectReason = z.infer<typeof NavRejectReasonSchema>

export const NavResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string() }),
  z.object({ ok: z.literal(false), reason: NavRejectReasonSchema }),
])
export type NavResult = z.infer<typeof NavResultSchema>

export const BrowseStateSchema = z.object({
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean(),
})
export type BrowseState = z.infer<typeof BrowseStateSchema>

export const ShellNoticeSchema = z.object({
  code: z.enum(['DOWNLOAD_CANCELLED', 'NAVIGATION_BLOCKED', 'LOAD_FAILED']),
})
export type ShellNotice = z.infer<typeof ShellNoticeSchema>

/** Errors crossing IPC are plain objects, never thrown class instances. */
export const IpcErrorSchema = z.object({ code: z.string(), message: z.string() })
export type IpcError = z.infer<typeof IpcErrorSchema>

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

// ---------------------------------------------------------------------------
// Channel declarations
// ---------------------------------------------------------------------------

/** Which webContents may call a channel. All skeleton channels are shell-only. */
export type SenderKind = 'shell' | 'browse'

export interface ChannelDef<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  readonly req: Req
  readonly res: Res
  readonly senders: readonly SenderKind[]
}

function def<Req extends z.ZodType, Res extends z.ZodType>(
  req: Req,
  res: Res,
  senders: readonly SenderKind[] = ['shell'],
): ChannelDef<Req, Res> {
  return { req, res, senders }
}

export const ipc = {
  'browse:navigate': def(z.object({ input: z.string().max(4096) }), NavResultSchema),
  'browse:go': def(z.object({ action: z.enum(['back', 'forward', 'reload', 'stop']) }), z.void()),
  'shell:panel-visibility': def(z.object({ open: z.boolean() }), z.void()),
  'config:get': def(z.void(), ConfigSchema),
  'config:update': def(ConfigPatchSchema, ConfigSchema),
  'llama:status': def(z.void(), z.array(ServerStatusSchema)),
  'llama:control': def(
    z.object({
      role: ServerRoleSchema,
      action: z.enum(['start', 'stop', 'restart']),
    }),
    ServerStatusSchema,
  ),
} as const satisfies Record<InvokeChannel, ChannelDef>

export const events = {
  'browse:state': BrowseStateSchema,
  'config:changed': ConfigSchema,
  'llama:status': ServerStatusSchema,
  'shell:notice': ShellNoticeSchema,
} as const satisfies Record<EventChannel, z.ZodType>

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Request type as the caller writes it (before defaults are applied). */
export type InvokeReq<C extends InvokeChannel> = z.input<(typeof ipc)[C]['req']>
/** Request type as the handler receives it (after validation). */
export type InvokeParsedReq<C extends InvokeChannel> = z.output<(typeof ipc)[C]['req']>
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof ipc)[C]['res']>
export type EventPayload<E extends EventChannel> = z.output<(typeof events)[E]>
