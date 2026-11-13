import type { Backend } from '../config/schema'
import type { LlamaErrorCode, ServerStatus } from '../ipc/contract'

/** Errors that mean "this binary did not work", as opposed to a missing model file. */
const BACKEND_FAILURE_CODES: ReadonlySet<LlamaErrorCode> = new Set<LlamaErrorCode>([
  'BINARY_MISSING',
  'SPAWN_FAILED',
  'STARTUP_TIMEOUT',
  'EXITED',
  'CRASH_LOOP',
])

/**
 * R12.4: when the CUDA (or custom) build does not reach `ready`, the UI shows the error and offers to switch
 * back to Vulkan. Returns true when that offer should be shown. Nothing switches automatically: the user chooses.
 */
export function shouldOfferVulkanFallback(backend: Backend, statuses: readonly ServerStatus[]): boolean {
  if (backend === 'vulkan') return false
  return statuses.some((s) => s.state === 'error' && s.errorCode !== null && BACKEND_FAILURE_CODES.has(s.errorCode))
}