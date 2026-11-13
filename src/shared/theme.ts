/** Colour themes. The palettes live in renderer/src/ui/theme.css; main only needs the window chrome colours. */

export const THEMES = ['night', 'paper', 'system'] as const
export type ThemeSetting = (typeof THEMES)[number]
export type ThemeName = Exclude<ThemeSetting, 'system'>

/** 'system' follows Windows' light/dark setting. */
export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ThemeName {
  if (setting === 'system') return systemDark ? 'night' : 'paper'
  return setting
}

/** Window background and the colours Windows uses for the minimise/maximise/close buttons. Must match `--bg` / `--text`. */
export const WINDOW_CHROME: Record<ThemeName, { background: string; symbol: string }> = {
  night: { background: '#16131a', symbol: '#ece6ea' },
  paper: { background: '#f6f3ec', symbol: '#2b2722' },
}
