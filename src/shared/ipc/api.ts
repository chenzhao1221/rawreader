import type { EventChannel, InvokeChannel } from './channels'
import type { EventPayload, InvokeReq, InvokeRes, IpcResult } from './contract'

/** Arguments of `invoke`: the request is omitted for channels whose request type is `void`. */
export type InvokeArgs<C extends InvokeChannel> = [InvokeReq<C>] extends [void]
  ? []
  : [req: InvokeReq<C>]

/** The API the shell preload exposes as `window.rawreader`. */
export interface RawReaderApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcResult<InvokeRes<C>>>
  /** Subscribes to a main-to-renderer event. Returns an unsubscribe function. */
  on<E extends EventChannel>(event: E, callback: (payload: EventPayload<E>) => void): () => void
}
