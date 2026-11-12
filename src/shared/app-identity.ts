import identity from '../../app-identity.json'

export interface AppIdentity {
  /** Display name. Used for window titles and installer names. */
  readonly productName: string
  /** Reverse-DNS application id used by electron-builder. */
  readonly appId: string
  /** Folder name under %APPDATA%. Dev builds append "-dev". */
  readonly userDataDirName: string
}

/** Single source of truth for the product identity (see app-identity.json). */
export const appIdentity: AppIdentity = identity
