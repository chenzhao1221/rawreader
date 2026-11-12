import { join } from 'node:path'
import type { Config } from '../../shared/config/schema'

export const SERVER_EXE_NAME = 'llama-server.exe'

export interface BackendEnv {
  /** `app.getPath('userData')`. */
  userDataDir: string
  /** Folder holding bundled extraResources (`process.resourcesPath` when packaged). */
  resourcesDir: string
  exists: (path: string) => boolean
}

export type BackendResolution =
  | { ok: true; binDir: string; exePath: string }
  | { ok: false; code: 'BINARY_MISSING'; expectedPath: string | null; message: string }

/**
 * Directory that should contain llama-server.exe for the configured backend:
 * vulkan  -> binDirs.vulkan ?? <resources>/llama/vulkan
 * cuda    -> binDirs.cuda   ?? <userData>/llama/cuda-<build>
 * custom  -> binDirs.custom (required)
 */
export function resolveBinDir(llama: Config['llama'], env: Pick<BackendEnv, 'userDataDir' | 'resourcesDir'>): string | null {
  switch (llama.backend) {
    case 'vulkan':
      return llama.binDirs.vulkan ?? join(env.resourcesDir, 'llama', 'vulkan')
    case 'cuda':
      return llama.binDirs.cuda ?? join(env.userDataDir, 'llama', `cuda-${llama.build}`)
    case 'custom':
      return llama.binDirs.custom
  }
}

/** Resolves the llama-server executable. Missing binaries yield a `BINARY_MISSING` result. */
export function resolveServerExe(llama: Config['llama'], env: BackendEnv): BackendResolution {
  const binDir = resolveBinDir(llama, env)
  if (binDir === null) {
    return {
      ok: false,
      code: 'BINARY_MISSING',
      expectedPath: null,
      message: `No folder is configured for the "${llama.backend}" backend`,
    }
  }
  const exePath = join(binDir, SERVER_EXE_NAME)
  if (!env.exists(exePath)) {
    return {
      ok: false,
      code: 'BINARY_MISSING',
      expectedPath: exePath,
      message: `${SERVER_EXE_NAME} not found at ${exePath}`,
    }
  }
  return { ok: true, binDir, exePath }
}
