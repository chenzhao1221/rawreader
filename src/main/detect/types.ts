/** Axis-aligned box in image pixel coordinates (x1,y1 top-left, x2,y2 bottom-right). */
export interface Bbox {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Detector score, 0..1. */
  confidence: number
}

/** Detector output split by class. Bubble boxes are kept even when no text box exists. */
export interface DetectedGroups {
  textBoxes: Bbox[]
  bubbleBoxes: Bbox[]
}

/** One translatable region (requirements glossary: "Unit"). */
export interface DetectedUnit {
  kind: 'bubble' | 'free'
  /** Where the translation is drawn: the bubble, or the free text box. */
  drawBox: Bbox
  /** What is cropped for OCR: the union of the text boxes inside a bubble, else the bubble/text box itself. */
  ocrBox: Bbox
  /** True when a bubble had no text box and is OCR'd as a whole. */
  bubbleOnly: boolean
}
