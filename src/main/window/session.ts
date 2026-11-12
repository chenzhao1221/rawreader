import { session } from 'electron'
import { BROWSE_PARTITION } from '../../shared/constants'
import type { ShellNotice } from '../../shared/ipc/contract'
import { sanitizeUserAgent } from './user-agent'

/**
 * One-time setup of the persistent browse session: plain Chrome user agent,
 * every permission denied, downloads cancelled (phase 1 has no download UI).
 */
export function setupBrowseSession(notify: (notice: ShellNotice) => void): Electron.Session {
  const ses = session.fromPartition(BROWSE_PARTITION)

  ses.setUserAgent(sanitizeUserAgent(ses.getUserAgent()))

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)

  ses.on('will-download', (_event, item) => {
    item.cancel()
    notify({ code: 'DOWNLOAD_CANCELLED' })
  })

  return ses
}
