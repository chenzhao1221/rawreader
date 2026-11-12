/**
 * Flags that must never appear in user-supplied llama-server extra arguments.
 * The bind address and port are owned by the process manager, so the server
 * can never be widened beyond 127.0.0.1 or moved to an unexpected port.
 */
const FORBIDDEN_FLAGS = ['--host', '--port'] as const

/** Returns the forbidden flags found in `extraArgs`, including the `--flag=value` form. */
export function findForbiddenExtraArgs(extraArgs: readonly string[]): string[] {
  const found: string[] = []
  for (const arg of extraArgs) {
    for (const flag of FORBIDDEN_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) found.push(arg)
    }
  }
  return found
}
