import { describe, expect, it } from 'vitest'
import { backgroundImageUrl, imageMatchesUrl, imageUrls, normalizeUrl, pickBackgroundTarget, pickContextImage } from './context-image'
import type { ImageLike } from './context-image'

const PAGE = 'https://reader.example.test/series/1/chapter/2'
const URL_A = 'https://cdn.example.test/p/1.jpg'
const URL_B = 'https://cdn.example.test/p/2.jpg'

function img(init: { src?: string; currentSrc?: string; attrs?: Record<string, string> }): ImageLike {
  const attrs: Record<string, string> = { ...(init.src ? { src: init.src } : {}), ...(init.attrs ?? {}) }
  return { src: init.src, currentSrc: init.currentSrc, getAttribute: (name) => attrs[name] ?? null }
}

describe('normalizeUrl', () => {
  it('resolves relative URLs and drops the fragment but keeps the query', () => {
    expect(normalizeUrl('/p/1.jpg?w=2#x', PAGE)).toBe('https://reader.example.test/p/1.jpg?w=2')
  })
  it('keeps data and blob URLs and rejects empty input', () => {
    expect(normalizeUrl('data:image/png;base64,AA', PAGE)).toBe('data:image/png;base64,AA')
    expect(normalizeUrl('blob:https://reader.example.test/x', PAGE)).toBe('blob:https://reader.example.test/x')
    expect(normalizeUrl('  ', PAGE)).toBeNull()
    expect(normalizeUrl(undefined, PAGE)).toBeNull()
  })
})

describe('imageUrls / imageMatchesUrl', () => {
  it('matches the shown URL, a relative src, lazy attributes and srcset entries', () => {
    expect(imageMatchesUrl(img({ currentSrc: URL_A }), URL_A, PAGE)).toBe(true)
    expect(imageMatchesUrl(img({ src: '/p/1.jpg' }), 'https://reader.example.test/p/1.jpg', PAGE)).toBe(true)
    for (const name of ['data-src', 'data-original', 'data-lazy-src']) {
      expect(imageMatchesUrl(img({ src: 'data:image/gif;base64,R0lGOD', attrs: { [name]: URL_A } }), URL_A, PAGE)).toBe(true)
    }
    expect(imageMatchesUrl(img({ attrs: { srcset: `${URL_B} 1x, ${URL_A} 2x` } }), URL_A, PAGE)).toBe(true)
    expect(imageMatchesUrl(img({ attrs: { 'data-srcset': `${URL_A} 800w` } }), URL_A, PAGE)).toBe(true)
  })
  it('does not match another image or an empty URL', () => {
    expect(imageMatchesUrl(img({ src: URL_B }), URL_A, PAGE)).toBe(false)
    expect(imageMatchesUrl(img({ src: URL_A }), '', PAGE)).toBe(false)
  })
  it('lists each URL once per source', () => {
    expect(imageUrls(img({ src: URL_A, currentSrc: URL_A }), PAGE)).toContain(URL_A)
  })
})

describe('pickContextImage', () => {
  it('prefers the stacked image that shows the URL', () => {
    const top = img({ src: URL_B })
    const under = img({ src: URL_A })
    expect(pickContextImage([top, under], [top, under], URL_A, PAGE)).toBe(under)
  })

  it('falls back to any page image carrying the URL when nothing at the click point matches', () => {
    const lazy = img({ src: 'data:image/gif;base64,R0lGOD', attrs: { 'data-src': URL_A } })
    const other = img({ src: URL_B })
    expect(pickContextImage([], [other, lazy], URL_A, PAGE)).toBe(lazy)
  })

  it('falls back to the topmost image at the click point when no URL matches', () => {
    const top = img({ src: 'https://cdn.example.test/p/rewritten.jpg' })
    expect(pickContextImage([top], [top], URL_A, PAGE)).toBe(top)
  })

  it('returns null when there is nothing', () => {
    expect(pickContextImage([], [], URL_A, PAGE)).toBeNull()
    expect(pickContextImage([], [img({ src: URL_B })], URL_A, PAGE)).toBeNull()
  })
})

describe('backgroundImageUrl', () => {
  it('reads quoted, single-quoted and unquoted url() values and resolves relative ones', () => {
    expect(backgroundImageUrl(`url("${URL_A}")`, PAGE)).toBe(URL_A)
    expect(backgroundImageUrl(`url('${URL_A}')`, PAGE)).toBe(URL_A)
    expect(backgroundImageUrl(`url(${URL_A})`, PAGE)).toBe(URL_A)
    expect(backgroundImageUrl('url("/p/3.jpg#x")', PAGE)).toBe('https://reader.example.test/p/3.jpg')
  })
  it('takes the first url() layer and skips gradients', () => {
    expect(backgroundImageUrl(`linear-gradient(red, blue), url("${URL_B}"), url("${URL_A}")`, PAGE)).toBe(URL_B)
    expect(backgroundImageUrl('linear-gradient(red, blue)', PAGE)).toBeNull()
  })
  it('keeps data URLs and returns null for none or empty values', () => {
    expect(backgroundImageUrl('url("data:image/png;base64,AAAA")', PAGE)).toBe('data:image/png;base64,AAAA')
    expect(backgroundImageUrl('none', PAGE)).toBeNull()
    expect(backgroundImageUrl('', PAGE)).toBeNull()
    expect(backgroundImageUrl(undefined, PAGE)).toBeNull()
  })
})

describe('pickBackgroundTarget', () => {
  it('returns the topmost element that paints a background picture', () => {
    const layers = [{ id: 'layer', css: 'none' }, { id: 'frame', css: `url("${URL_A}")` }, { id: 'page', css: `url("${URL_B}")` }]
    expect(pickBackgroundTarget(layers, (el) => el.css, PAGE)).toEqual({ el: layers[1], url: URL_A })
  })
  it('returns null when nothing at the point has a background picture', () => {
    expect(pickBackgroundTarget([{ css: 'none' }], (el) => el.css, PAGE)).toBeNull()
    expect(pickBackgroundTarget([], () => null, PAGE)).toBeNull()
  })
})