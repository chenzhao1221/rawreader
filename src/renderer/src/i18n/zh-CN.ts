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
  tabs: {
    newTab: '新标签页（Ctrl+T）',
    close: '关闭标签页（Ctrl+W）',
    untitled: '新标签页',
  },
  engine: {
    title: '谁来认字和翻译',
    local: '本机模型（默认）',
    localNote: '认字和翻译都在你电脑上跑，不联网、不花钱。要先下载约 3 GB 模型，吃显卡。',
    openai: '本机认字 + 外部接口翻译',
    openaiNote: '认字还在本机，翻译交给 DeepSeek 这类 OpenAI 格式的接口。翻译更好，按用量付费。',
    gemini: 'Gemini 一条龙',
    geminiNote: '认字和翻译都交给 Gemini，不用下载大模型，电脑配置低也能用。需要 Gemini 密钥，要能连上 Google。',
    apiTitle: '翻译接口',
    geminiTitle: 'Gemini',
    baseUrl: '接口地址',
    model: '模型名',
    apiKey: '密钥',
    keySet: '已设置',
    keepKey: '留空就用已保存的密钥',
    removeKey: '删除密钥',
    keyFailed: '密钥没存上：系统加密不可用。',
    needKey: '已保存，但还没有密钥，翻译暂时不会运行。',
    invalid: '有项填得不对：接口地址要用 https://，或本机的 http://127.0.0.1。',
    geminiKeyNote: '在 Google AI Studio（aistudio.google.com）免费申请。',
    keyStorage: '密钥用 Windows 加密保存在本机，只发给你填的接口，不写进日志和配置文件。',
  },
  webBar: {
    offer: (lang: string): string => `这个网页是${lang}。要翻译成中文吗？`,
    translating: '正在翻译成中文…',
    translated: '已翻译成中文。',
    error: '网页翻译失败。',
    translate: '翻译',
    showOriginal: '看原文',
    retry: '重试',
    always: (lang: string): string => `总是翻译${lang}`,
    neverLang: (lang: string): string => `不翻译${lang}`,
    neverSite: '这个网站不翻',
    close: '关闭',
    unknownLang: '外语',
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
    tabs: { engine: '翻译方式', models: '模型', servers: '服务与后端', advanced: '缓存与高级', licenses: '开源许可' },
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
    ahead: '提前翻多远',
    aheadOff: '关（看到才翻）',
    aheadNear: '近（约 1 屏）',
    aheadFar: '远（约 5 屏）',
    aheadNote: '往下还没看到的图也先翻好。越远越不用等，但会多翻一些可能不看的图。同时识别数、同时翻译数调大会多占显存。',
    bubblesOnly: '只翻气泡里的字',
    bubblesOnlyNote: '开启后，气泡外的文字（拟声词、旁白等）不再识别、翻译或覆盖。关闭后可恢复显示。',
    adBlock: '去广告',
    adBlockNote: '拦截广告和跟踪请求，并隐藏网页上的广告位（用 uBlock Origin 同款名单，每 3 天更新一次）。某个网站显示不正常时可以先关掉试试。',
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

/** Names of the languages most pages use. Others show as "外语". */
const languageNames: Record<string, string> = {
  en: '英语', ko: '韩语', ja: '日语', es: '西班牙语', pt: '葡萄牙语', fr: '法语', de: '德语', it: '意大利语',
  ru: '俄语', th: '泰语', vi: '越南语', id: '印尼语', ms: '马来语', tr: '土耳其语', ar: '阿拉伯语', pl: '波兰语',
  nl: '荷兰语', uk: '乌克兰语', fil: '菲律宾语', tl: '菲律宾语', hi: '印地语',
}

export const label = {
  language: (code: string): string => languageNames[code] ?? zhCN.webBar.unknownLang,
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
