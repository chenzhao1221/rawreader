import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { InvokeChannel } from '../../shared/ipc/channels'
import { ipc } from '../../shared/ipc/contract'
import type { InvokeParsedReq, InvokeRes, IpcResult, SenderKind } from '../../shared/ipc/contract'
import { createLogger } from '../log/log'
import type { Logger } from '../log/log'

/** Ids of the webContents allowed to call each kind of channel. `null` while the view does not exist. */
export interface SenderIds {
  shell(): number | null
  browse(): number | null
}

/** The part of IpcMain this module uses. Lets tests pass a fake without importing Electron. */
export type IpcMainLike = Pick<IpcMain, 'handle' | 'removeHandler'>

export type SenderEventLike = Pick<IpcMainInvokeEvent, 'sender'>

export type ChannelHandler<C extends InvokeChannel> = (
  req: InvokeParsedReq<C>,
  event: SenderEventLike,
) => InvokeRes<C> | Promise<InvokeRes<C>>

function isAllowedSender(event: SenderEventLike, allowed: readonly SenderKind[], ids: SenderIds): boolean {
  const senderId = event.sender.id
  return allowed.some((kind) => {
    const id = kind === 'shell' ? ids.shell() : ids.browse()
    return id !== null && id === senderId
  })
}

/**
 * Builds the function Electron calls for a channel: checks the sender, parses
 * the payload with zod, runs the handler and maps every failure to a plain
 * `{ code, message }` error. Exported for tests.
 */
export function createChannelHandler<C extends InvokeChannel>(
  channel: C,
  handler: ChannelHandler<C>,
  ids: SenderIds,
  logger: Logger,
): (event: SenderEventLike, raw: unknown) => Promise<IpcResult<InvokeRes<C>>> {
  const def = ipc[channel]
  return async (event, raw) => {
    if (!isAllowedSender(event, def.senders, ids)) {
      logger.warn(`Rejected IPC call on "${channel}" from an unexpected sender`)
      return { ok: false, error: { code: 'FORBIDDEN_SENDER', message: 'Sender is not allowed on this channel' } }
    }

    const parsed = def.req.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return { ok: false, error: { code: 'INVALID_PAYLOAD', message: `Invalid payload for "${channel}": ${detail}` } }
    }

    try {
      const value = await handler(parsed.data as InvokeParsedReq<C>, event)
      return { ok: true, value }
    } catch (error) {
      logger.error(`Handler for "${channel}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: { code: 'INTERNAL', message: 'Internal error' } }
    }
  }
}

export interface IpcRegistrar {
  handle<C extends InvokeChannel>(channel: C, handler: ChannelHandler<C>): void
  dispose(): void
}

/** Only this folder registers IPC handlers. */
export function createIpcRegistrar(
  ipcMain: IpcMainLike,
  ids: SenderIds,
  logger: Logger = createLogger('ipc'),
): IpcRegistrar {
  const registered: InvokeChannel[] = []
  return {
    handle(channel, handler) {
      const wrapped = createChannelHandler(channel, handler, ids, logger)
      ipcMain.handle(channel, (event, raw: unknown) => wrapped(event, raw))
      registered.push(channel)
    },
    dispose() {
      for (const channel of registered.splice(0)) ipcMain.removeHandler(channel)
    },
  }
}
