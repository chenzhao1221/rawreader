import type { LlamaErrorCode, NavRejectReason, ServerRole, ServerState, ShellNotice } from '../../../shared/ipc/contract'

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
  },
  browse: {
    emptyHint: '在上方地址栏输入网址，开始阅读。',
    loading: '加载中…',
  },
  status: {
    pipelinePlaceholder: '自动翻译流程尚未接入（占位提示）',
    ocrRole: '文字识别',
    translateRole: '翻译',
  },
  errors: {
    generic: '操作失败，请重试。',
    ipcUnavailable: '无法连接到应用主进程。',
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
