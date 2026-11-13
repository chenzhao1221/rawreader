import type { Config } from '../../shared/config/schema'
import type { PageConfig } from '../../shared/ipc/contract'
import type { PipelineSettings } from './scheduler'

/** Pixels added around each OCR crop (R7.1). Not user-configurable in phase 1. */
export const OCR_PADDING_PX = 8

/** Detector noise guard: no page needs more units than this. */
export const MAX_UNITS_PER_IMAGE = 60

/** Scheduler settings derived from config. Concurrency defaults to each server's `-np` (R5.6). */
export function pipelineSettingsFrom(config: Config): PipelineSettings {
  return {
    maxImageBytes: config.pipeline.maxImageBytes,
    ocrConcurrency: config.pipeline.ocrConcurrency ?? config.llama.ocr.parallel,
    translateConcurrency: config.pipeline.translateConcurrency ?? config.llama.translate.parallel,
    readingDirection: config.pipeline.readingDirection,
    ocrPadding: OCR_PADDING_PX,
    maxUnitsPerImage: MAX_UNITS_PER_IMAGE,
  }
}

/** What the browse preload needs to know. */
export function pageConfigFrom(config: Config): PageConfig {
  return {
    enabled: config.ui.autoTranslate,
    overlayVisible: config.ui.overlayVisible,
    minImageSize: config.pipeline.minImageSize,
    rootMarginPx: config.pipeline.rootMarginPx,
  }
}
