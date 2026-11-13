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

export const TabInfoSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
})
export type TabInfo = z.infer<typeof TabInfoSchema>

export const TabsStateSchema = z.object({
  tabs: z.array(TabInfoSchema),
  activeId: z.number().int().nullable(),
})
export type TabsState = z.infer<typeof TabsStateSchema>

export const ShellNoticeSchema = z.object({
  code: z.enum(['DOWNLOAD_CANCELLED', 'NAVIGATION_BLOCKED', 'LOAD_FAILED']),
})
export type ShellNotice = z.infer<typeof ShellNoticeSchema>

// ---------------------------------------------------------------------------
// Browse page <-> main (untrusted, page-adjacent input; always validated)
// ---------------------------------------------------------------------------

/** Settings the browse preload needs. Pushed on change and returned by page:hello. */
export const PageConfigSchema = z.object({
  enabled: z.boolean(),
  /** Global show translation switch; false hides every overlay (R3.3). */
  overlayVisible: z.boolean(),
  minImageSize: z.number().int().min(0),
  rootMarginPx: z.number().int().min(0),
})
export type PageConfig = z.infer<typeof PageConfigSchema>

/** The preload announces each new document with a fresh random id (R5.5). */
export const PageHelloSchema = z.object({
  docId: z.string().min(8).max(64),
  url: z.string().max(8192),
})

export const PageImageSchema = z.object({
  /** Stable per-element id assigned by the preload (data-rr-id). */
  elId: z.string().min(1).max(64),
  url: z.string().min(1).max(8192),
  naturalW: z.number().int().min(0).max(100_000),
  naturalH: z.number().int().min(0).max(1_000_000),
  /** CSS pixels between the image and the viewport; 0 when visible. Smaller runs first. */
  distance: z.number().min(0).max(10_000_000),
})
export type PageImage = z.infer<typeof PageImageSchema>

export const PageImagesBatchSchema = z.object({
  docId: z.string().min(8).max(64),
  pageUrl: z.string().max(8192),
  images: z.array(PageImageSchema).min(1).max(200),
})
export type PageImagesBatch = z.infer<typeof PageImagesBatchSchema>

/** Per-page progress shown in the shell (R5.7). */
export const PipelineProgressSchema = z.object({
  total: z.number().int().min(0),
  done: z.number().int().min(0),
  failed: z.number().int().min(0),
  active: z.number().int().min(0),
})
export type PipelineProgress = z.infer<typeof PipelineProgressSchema>

const OverlayBoxSchema = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })

/** One translated region to draw. Boxes are in the pixel space of the analysed image (width x height). */
export const OverlayUnitSchema = z.object({
  kind: z.enum(['bubble', 'free']),
  box: OverlayBoxSchema,
  text: z.string().max(2000),
})
export type OverlayUnit = z.infer<typeof OverlayUnitSchema>

/** Main to browse preload: a finished image for one element. Carries no image bytes and no source text. */
export const OverlayResultSchema = z.object({
  docId: z.string().min(8).max(64),
  elId: z.string().min(1).max(64),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  units: z.array(OverlayUnitSchema).max(200),
})
export type OverlayResult = z.infer<typeof OverlayResultSchema>
export const CacheStatsSchema = z.object({ entries: z.number().int().min(0), bytes: z.number().min(0) })
export type CacheStats = z.infer<typeof CacheStatsSchema>

// ---------------------------------------------------------------------------
// Models, CUDA backend, licences (shell only)
// ---------------------------------------------------------------------------

export const ModelRoleSchema = z.enum(['detector', 'ocr', 'ocrMmproj', 'translator'])
export type ModelRoleName = z.infer<typeof ModelRoleSchema>

export const ModelCheckSchema = z.enum(['unchecked', 'checking', 'ok', 'size-mismatch', 'hash-mismatch', 'unreadable'])
export type ModelCheck = z.infer<typeof ModelCheckSchema>

export const ModelOriginSchema = z.enum(['config', 'models-dir', 'bundled', 'missing'])

export const ModelDownloadSchema = z.object({
  status: z.enum(['queued', 'downloading', 'verifying', 'done', 'paused', 'cancelled', 'error']),
  receivedBytes: z.number().min(0),
  totalBytes: z.number().min(0),
  bytesPerSecond: z.number().min(0),
  source: z.enum(['huggingface', 'modelscope']).nullable(),
  attempt: z.number().int().min(0),
  errorCode: z.string().nullable(),
})
export type ModelDownload = z.infer<typeof ModelDownloadSchema>

export const ModelItemSchema = z.object({
  role: ModelRoleSchema,
  fileName: z.string(),
  displayName: z.string(),
  size: z.number().min(0),
  bundled: z.boolean(),
  /** Absolute path of the file in use, or null when missing. */
  path: z.string().nullable(),
  /** Where the file is expected (target of a download). */
  expectedPath: z.string(),
  origin: ModelOriginSchema,
  check: ModelCheckSchema,
  download: ModelDownloadSchema.nullable(),
})
export type ModelItem = z.infer<typeof ModelItemSchema>

export const ModelsOverviewSchema = z.object({
  /** Folder downloads go to. */
  modelsDir: z.string(),
  /** False in dev (`models.autoDownload: false`): the app never downloads models. */
  downloadsAllowed: z.boolean(),
  /** A required model is missing and downloads are allowed: show the first-run panel. */
  needsSetup: z.boolean(),
  /** Bytes still to download for missing required files. */
  missingBytes: z.number().min(0),
  items: z.array(ModelItemSchema),
})
export type ModelsOverview = z.infer<typeof ModelsOverviewSchema>

export const ModelNoticeSchema = z.object({
  code: z.enum(['canceled', 'size-mismatch', 'downloads-disabled', 'nothing-to-download', 'nothing-found', 'unreadable']),
  role: ModelRoleSchema.optional(),
  /** Set with `size-mismatch`: the file the user may still choose to use. */
  path: z.string().optional(),
})
export type ModelNotice = z.infer<typeof ModelNoticeSchema>

export const ModelsActionResultSchema = z.object({ overview: ModelsOverviewSchema, notice: ModelNoticeSchema.nullable() })
export type ModelsActionResult = z.infer<typeof ModelsActionResultSchema>

export const CudaStatusSchema = z.object({
  state: z.enum(['absent', 'checking', 'downloading', 'extracting', 'ready', 'error']),
  /** llama-server.exe is present in the CUDA folder. */
  installed: z.boolean(),
  receivedBytes: z.number().min(0),
  totalBytes: z.number().min(0),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  /** Target folder. */
  dir: z.string(),
})
export type CudaStatus = z.infer<typeof CudaStatusSchema>

export const LicenseDocumentSchema = z.object({ id: z.string(), title: z.string(), text: z.string() })
export const LicensesSchema = z.object({ documents: z.array(LicenseDocumentSchema) })
export type Licenses = z.infer<typeof LicensesSchema>
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
  'tabs:get': def(z.void(), TabsStateSchema),
  'tabs:new': def(z.object({ input: z.string().max(4096).optional() }), NavResultSchema),
  'tabs:close': def(z.object({ id: z.number().int() }), z.void()),
  'tabs:activate': def(z.object({ id: z.number().int() }), z.void()),
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
  'app:open-logs': def(z.void(), z.void()),
  'page:hello': def(PageHelloSchema, PageConfigSchema, ['browse']),
  'page:images': def(PageImagesBatchSchema, z.void(), ['browse']),
  'models:overview': def(z.void(), ModelsOverviewSchema),
  'models:download': def(
    z.object({ action: z.enum(['start', 'pause', 'resume', 'cancel']), role: ModelRoleSchema.optional() }),
    ModelsActionResultSchema,
  ),
  'models:pick-folder': def(z.void(), ModelsActionResultSchema),
  'models:locate-folder': def(z.void(), ModelsActionResultSchema),
  'models:pick-file': def(z.object({ role: ModelRoleSchema }), ModelsActionResultSchema),
  'models:use-file': def(z.object({ role: ModelRoleSchema, path: z.string().min(1).max(4096) }), ModelsActionResultSchema),
  'models:clear-path': def(z.object({ role: ModelRoleSchema }), ModelsActionResultSchema),
  'cuda:status': def(z.void(), CudaStatusSchema),
  'cuda:download': def(z.object({ action: z.enum(['start', 'cancel']) }), CudaStatusSchema),
  'licenses:get': def(z.void(), LicensesSchema),
  'cache:stats': def(z.void(), CacheStatsSchema),
  'cache:clear': def(z.void(), CacheStatsSchema),
  'overlay:font': def(z.void(), z.custom<Uint8Array>((v) => v instanceof Uint8Array).nullable(), ['browse']),
} as const satisfies Record<InvokeChannel, ChannelDef>

export const events = {
  'browse:state': BrowseStateSchema,
  'tabs:state': TabsStateSchema,
  'shell:focus-address': z.object({}),
  'config:changed': ConfigSchema,
  'llama:status': ServerStatusSchema,
  'shell:notice': ShellNoticeSchema,
  'page:config': PageConfigSchema,
  'pipeline:progress': PipelineProgressSchema,
  'overlay:result': OverlayResultSchema,
  'models:changed': ModelsOverviewSchema,
  'cuda:changed': CudaStatusSchema,
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
