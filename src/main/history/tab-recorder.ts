import { isHttpUrl } from '../window/address'
import type { HistoryTouch } from './record'

/** The part of a browse `webContents` the recorder uses. A fake with the same shape drives the tests. */
export interface RecorderTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
}

/**
 * Records the pages shown in one browse tab. A main-frame navigation (also within a page, for readers that change
 * chapter without loading) counts as a visit. A title change or the end of loading only completes the entry of the
 * page that is shown: it fills in the title and never counts a second visit.
 */
export function attachHistoryRecorder(target: RecorderTarget, record: (touch: HistoryTouch) => void): void {
  let recordedUrl = ''
  const touch = (visit: boolean): void => {
    if (target.isDestroyed()) return
    const url = target.getURL()
    if (!isHttpUrl(url)) return
    if (!visit && url !== recordedUrl) return
    recordedUrl = url
    record({ url, title: target.getTitle(), refresh: !visit })
  }
  target.on('did-navigate', () => touch(true))
  target.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame === true) touch(true)
  })
  target.on('page-title-updated', () => touch(false))
  target.on('did-stop-loading', () => touch(false))
}
