import { describe, expect, it } from 'vitest'
import { STATUS_HEIGHT, TOOLBAR_HEIGHT } from '../../shared/constants'
import { computeBrowseBounds } from './layout'

describe('computeBrowseBounds', () => {
  it('fills the area between the toolbar and the status bar', () => {
    expect(computeBrowseBounds({ width: 1280, height: 860 })).toEqual({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: 1280,
      height: 860 - TOOLBAR_HEIGHT - STATUS_HEIGHT,
    })
  })

  it('never returns negative sizes for a tiny window', () => {
    expect(computeBrowseBounds({ width: 100, height: 40 })).toMatchObject({ width: 100, height: 0 })
    expect(computeBrowseBounds({ width: -5, height: 0 }).width).toBe(0)
  })

  it('floors fractional sizes', () => {
    expect(computeBrowseBounds({ width: 800.9, height: 600.7 })).toMatchObject({ width: 800, height: 600 - TOOLBAR_HEIGHT - STATUS_HEIGHT })
  })
})
