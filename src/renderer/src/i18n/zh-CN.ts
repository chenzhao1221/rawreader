import type {
  CudaStatus,
  LlamaErrorCode,
  ModelCheck,
  ModelDownload,
  ModelItem,
  ModelNotice,
  NavRejectReason,
  ServerRole,
  ServerState,
  ShellNotice,
} from '../../../shared/ipc/contract'

/** All user-visible strings of the shell UI (Simplified Chinese). */
export const zhCN = {
  toolbar: {
    back: '后退',
    forward: '前进',
    reload: '刷新',
    stop: '停止',
    addressLabel: '地址栏',
    addressPlaceholder: '输入网址，例如 example.com',
    autoTranslate: '自动翻译',
    overlayVisible: '显示译文',
    settings: '设置',
  },
  browse: {
    emptyHint: '在上方地址栏输入网址，开始阅读。',
    loading: '加载中…',
  },
  status: {
    openLogs: '打开日志文件夹',
    progress: '本页进度',
    failed: '失败',
    ocrRole: '文字识别',
    translateRole: '翻译',
  },
  errors: {
    generic: '操作失败，请重试。',
    ipcUnavailable: '无法连接到应用主进程。',
  },
  settings: {
    title: '设置',
    close: '关闭',
    tabs: { models: '模型', servers: '服务与后端', advanced: '缓存与高级', licenses: '开源许可' },
    apply: '应用',
    saved: '已保存。',
    invalid: '参数无效，未保存。',
    yes: '是',
    no: '否',
  },
  models: {
    folder: '模型文件夹',
    pickFolder: '选择文件夹…',
    locateFolder: '在文件夹中查找已有模型…',
    pickFile: '选择文件…',
    resetPath: '恢复默认',
    useAnyway: '仍然使用',
    download: '开始下载',
    downloadOne: '下载',
    pause: '暂停',
    resume: '继续',
    cancel: '取消',
    retry: '重试',
    setupTitle: '首次使用：需要准备模型',
    bundledNote: '随安装包提供',
    missing: '缺失',
    devNote: '开发模式：不会下载模型，使用 dev.config.json 中指定的本地文件。',
    sourceFallback: '主线路不可用，已切换到魔搭社区。',
    columns: { name: '模型', file: '文件', size: '大小', state: '状态', origin: '来源' },
  },
  servers: {
    heading: '推理服务',
    start: '启动',
    stop: '停止',
    restart: '重启',
    fields: {
      port: '端口',
      ctxSize: '上下文长度',
      nGpuLayers: 'GPU 层数 (-ngl)',
      parallel: '并行数 (-np)',
      flashAttn: '闪存注意力',
      alias: '模型别名',
      extraArgs: '额外参数（空格分隔）',
      autostart: '随应用自动启动',
      temp: '温度',
      reasoning: '推理模式',
    },
    flashAttn: { on: '开', off: '关', auto: '自动（不传参数）' },
    reasoning: { on: '开', off: '关' },
    backend: {
      heading: '推理后端',
      vulkan: 'Vulkan（内置，默认）',
      cuda: 'CUDA（NVIDIA 显卡）',
      custom: '自定义文件夹',
      customDir: '自定义文件夹路径（包含 llama-server.exe）',
      cudaDownload: '下载 CUDA 版本',
      cudaCancel: '取消下载',
      cudaNote: '需要从 GitHub 下载约 700 MB（两个压缩包），国内网络可能需要代理。',
      cudaInstalled: '已安装 CUDA 版本。',
      fallbackOffer: 'CUDA 或自定义后端未能正常启动。',
      switchToVulkan: '切换回 Vulkan',
    },
  },
  advanced: {
    pipeline: '翻译流程',
    ocrConcurrency: '文字识别并发数',
    translateConcurrency: '翻译并发数',
    auto: '自动（跟随服务并行数）',
    readingDirection: '阅读方向',
    ltr: '从左到右',
    rtl: '从右到左（日漫）',
    bubblesOnly: '只翻气泡里的字',
    bubblesOnlyNote: '开启后，气泡外的文字（拟声词、旁白等）不再识别、翻译或覆盖。关闭后可恢复显示。',
    mirrors: '下载镜像',
    huggingface: 'Hugging Face 镜像地址',
    modelscope: '魔搭社区（ModelScope）地址',
    cache: '结果缓存',
    cacheCap: '缓存上限（GB）',
    clearCache: '清除缓存',
    cacheCleared: '缓存已清除。',
    cacheNote: '缓存只保存识别和翻译结果，不保存原图。',
    logs: '日志',
    openLogs: '打开日志文件夹',
  },
  licenses: {
    heading: '开源许可',
    docs: { app: '本软件（AGPL-3.0）', notices: '第三方组件声明', font: 'Noto Sans SC 字体（OFL 1.1）' } as Record<string, string>,
    loading: '加载中…',
  },
} as const

const serverRoleLabels: Record<ServerRole, string> = {
  ocr: zhCN.status.ocrRole,
  translate: zhCN.status.translateRole,
}

const serverStateLabels: Record<ServerState, string> = {
  stopped: '已停止',
  starting: '启动中',
  ready: '就绪',
  stopping: '正在停止',
  error: '出错',
}

const llamaErrorLabels: Record<LlamaErrorCode, string> = {
  BINARY_MISSING: '未找到 llama-server 程序',
  MODEL_MISSING: '未找到模型文件',
  INVALID_CONFIG: '服务器配置无效',
  SPAWN_FAILED: '无法启动服务器',
  STARTUP_TIMEOUT: '启动超时',
  EXITED: '服务器意外退出，正在重试',
  CRASH_LOOP: '服务器反复崩溃，已停止重试',
}

const navRejectLabels: Record<NavRejectReason, string> = {
  empty: '请输入网址。',
  'unsupported-scheme': '只支持 http 和 https 网址。',
  invalid: '无法识别这个网址。',
}

const noticeLabels: Record<ShellNotice['code'], string> = {
  DOWNLOAD_CANCELLED: '已取消文件下载（当前版本不支持下载）。',
  NAVIGATION_BLOCKED: '已阻止打开非 http(s) 链接。',
  LOAD_FAILED: '页面加载失败。',
}

export const label = {
  serverRole: (role: ServerRole): string => serverRoleLabels[role],
  serverState: (state: ServerState): string => serverStateLabels[state],
  llamaError: (code: LlamaErrorCode): string => llamaErrorLabels[code],
  navReject: (reason: NavRejectReason): string => navRejectLabels[reason],
  notice: (code: ShellNotice['code']): string => noticeLabels[code],
}

const modelCheckLabels: Record<ModelCheck, string> = {
  unchecked: '未校验',
  checking: '校验中…',
  ok: '已就绪',
  'size-mismatch': '大小不符',
  'hash-mismatch': '校验失败',
  unreadable: '无法读取',
}

const modelOriginLabels: Record<ModelItem['origin'], string> = {
  config: '自选文件',
  'models-dir': '模型文件夹',
  bundled: '内置',
  missing: '—',
}

const downloadStatusLabels: Record<ModelDownload['status'], string> = {
  queued: '排队中',
  downloading: '下载中',
  verifying: '校验中',
  done: '完成',
  paused: '已暂停',
  cancelled: '已取消',
  error: '失败',
}

const downloadSourceLabels: Record<NonNullable<ModelDownload['source']>, string> = {
  huggingface: 'hf-mirror.com',
  modelscope: '魔搭社区',
}

const modelNoticeLabels: Record<ModelNotice['code'], string> = {
  canceled: '已取消。',
  'size-mismatch': '所选文件的大小与预期不符，可能不是正确的模型。',
  'downloads-disabled': '开发模式下不会下载模型。',
  'nothing-to-download': '没有需要下载的文件。',
  'nothing-found': '这个文件夹里没有找到已有的模型文件。',
  unreadable: '无法读取这个文件。',
}

const cudaStateLabels: Record<CudaStatus['state'], string> = {
  absent: '未安装',
  checking: '正在检查下载地址…',
  downloading: '下载中',
  extracting: '正在解压…',
  ready: '已安装',
  error: '安装失败',
}

const cudaErrorLabels: Record<string, string> = {
  UNSUPPORTED_BUILD: '当前 llama.cpp 版本没有对应的 CUDA 安装包。',
  UNREACHABLE: '无法连接到 GitHub，请检查网络或代理。',
  ASSET_MISSING: 'GitHub 上找不到安装包。',
  ASSET_CHANGED: '安装包大小与预期不符，已停止。',
  DOWNLOAD_FAILED: '下载失败或校验未通过。',
  EXTRACT_FAILED: '解压失败。',
  SERVER_MISSING: '压缩包里没有 llama-server.exe。',
  CANCELLED: '已取消。',
}

const downloadErrorLabels: Record<string, string> = {
  ALL_SOURCES_FAILED: '所有下载线路都失败了，请检查网络后重试。',
  HASH_MISMATCH: '文件校验未通过。',
  DISK: '无法写入磁盘，请检查剩余空间。',
}

/** 1536 -> "1.5 KB". Binary units, one decimal for MB and above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export const modelLabel = {
  check: (check: ModelCheck): string => modelCheckLabels[check],
  origin: (origin: ModelItem['origin']): string => modelOriginLabels[origin],
  downloadStatus: (status: ModelDownload['status']): string => downloadStatusLabels[status],
  source: (source: NonNullable<ModelDownload['source']>): string => downloadSourceLabels[source],
  notice: (code: ModelNotice['code']): string => modelNoticeLabels[code],
  downloadError: (code: string): string => downloadErrorLabels[code] ?? '下载失败。',
  setupBody: (missingBytes: number): string =>
    `以下模型文件还没有找到。可以下载（约 ${formatBytes(missingBytes)}，优先使用 hf-mirror.com，失败后改用魔搭社区），也可以选择电脑上已有的文件。`,
  speed: (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/秒`,
}

export const cudaLabel = {
  state: (state: CudaStatus['state']): string => cudaStateLabels[state],
  error: (code: string | null): string => (code ? (cudaErrorLabels[code] ?? '安装失败。') : ''),
}
