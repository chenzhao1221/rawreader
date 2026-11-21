/**
 * Pipeline concurrency select helpers. `null` in the config means "auto" (follow the llama-server parallel count);
 * the "auto" option has the value ''.
 */

/** Selectable values, `null` first (auto). */
export const CONCURRENCY_OPTIONS = [null, 1, 2, 3, 4, 6, 8] as const

/**
 * Value to bind to the select. An unset (null or undefined) setting must map to '' so the "auto" option is
 * selected; binding null would leave the select empty.
 */
export function concurrencySelectValue(value: number | null | undefined): number | '' {
  return value ?? ''
}

/** Option value attribute: '' for auto. */
export function concurrencyOptionValue(option: number | null): number | '' {
  return option ?? ''
}

/** Config value for what the select reports: '' is auto (null). */
export function parseConcurrencyInput(raw: string): number | null {
  return raw === '' ? null : Number(raw)
}
