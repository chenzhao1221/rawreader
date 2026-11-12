import type { RawReaderApi } from '../../shared/ipc/api'

declare global {
  interface Window {
    /** Typed IPC bridge exposed by the shell preload. */
    rawreader: RawReaderApi
  }
}

export {}
