import { statSync } from 'node:fs'
import type { Config } from '../../shared/config/schema'
import { resolveModelPath } from '../config/model-path'
import type { ModelPathEnv } from '../config/model-path'
import { buildCacheIdentity } from './key'
import type { CacheIdentity } from './key'

function fileSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** Reads the current config and the model files on every call, so a model swap changes the cache key at once. */
export function createIdentityProvider(getConfig: () => Config, env: ModelPathEnv): () => CacheIdentity {
  return () => {
    const config = getConfig()
    return buildCacheIdentity(
      config,
      {
        detector: resolveModelPath('detector', config, env),
        ocr: resolveModelPath('ocr', config, env),
        translator: resolveModelPath('translator', config, env),
      },
      fileSize,
    )
  }
}