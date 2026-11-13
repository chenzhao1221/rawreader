import { join } from 'node:path'
import type { Licenses } from '../shared/ipc/contract'

export interface LicenseSource {
  id: string
  /** English fallback title; the UI shows a Simplified Chinese title chosen by `id`. */
  title: string
  path: string
}

export interface LicenseBase {
  isPackaged: boolean
  /** `app.getAppPath()`: the repository root in dev. */
  appPath: string
  /** `process.resourcesPath` when packaged. */
  resourcesPath: string
}

/**
 * Documents shown in the "open source licences" view. In a packaged app they are installer extraResources
 * under `resources/licenses/`; in dev they are read from the repository.
 */
export function licenseSources(base: LicenseBase): LicenseSource[] {
  const at = (packaged: string, dev: string): string => (base.isPackaged ? join(base.resourcesPath, 'licenses', packaged) : join(base.appPath, dev))
  return [
    { id: 'app', title: 'RawReader licence (AGPL-3.0)', path: at('LICENSE', 'LICENSE') },
    { id: 'notices', title: 'Third-party notices', path: at('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md') },
    { id: 'font', title: 'Noto Sans SC (SIL OFL 1.1)', path: at('NotoSansSC-OFL.txt', join('resources', 'fonts', 'OFL.txt')) },
  ]
}

/** Reads the documents. A missing file becomes a short note instead of failing the whole view. */
export async function loadLicenses(sources: readonly LicenseSource[], readFile: (path: string) => Promise<string>): Promise<Licenses> {
  const documents = await Promise.all(
    sources.map(async (source) => {
      try {
        return { id: source.id, title: source.title, text: await readFile(source.path) }
      } catch {
        return { id: source.id, title: source.title, text: `(File not found: ${source.path})` }
      }
    }),
  )
  return { documents }
}