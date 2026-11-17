import type { Logger } from '../log/log'
import type { PipelineCache } from '../pipeline/scheduler'
import { buildCacheKey } from './key'
import type { CacheIdentity } from './key'
import { isCacheable } from './store'
import type { ResultCache } from './store'

/**
 * Connects the SQLite cache to the pipeline. The key is built from the current identity on every call, so a
 * model, language or prompt change is a miss without any invalidation step. Results with failed units are not
 * stored (a later visit retries them).
 */
export function createPipelineCache(options: {
  cache: ResultCache
  getIdentity: () => CacheIdentity
  logger: Logger
}): PipelineCache {
  return {
    lookup(hash, variant) {
      return options.cache.get(buildCacheKey(hash, options.getIdentity(), variant))
    },
    store(hash, result, variant) {
      if (!isCacheable(result)) {
        options.logger.debug('Result has failed units; not cached')
        return
      }
      options.cache.put(buildCacheKey(hash, options.getIdentity(), variant), hash, result)
    },
  }
}