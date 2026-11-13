import { describe, expect, it } from 'vitest'
import { ConfigPatchSchema, isAllowedApiBase } from './schema'

describe('isAllowedApiBase', () => {
  it('allows any https address', () => {
    expect(isAllowedApiBase('https://api.deepseek.com/v1')).toBe(true)
    expect(isAllowedApiBase('https://openrouter.ai/api/v1')).toBe(true)
    expect(isAllowedApiBase('https://example.com')).toBe(true)
  })

  it('allows plain http only to this computer', () => {
    expect(isAllowedApiBase('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isAllowedApiBase('http://localhost')).toBe(true)
    expect(isAllowedApiBase('http://[::1]:8080/v1')).toBe(true)
  })

  it('rejects plain http to another host', () => {
    expect(isAllowedApiBase('http://example.com')).toBe(false)
    expect(isAllowedApiBase('http://192.168.1.20:1234/v1')).toBe(false)
  })

  it('rejects addresses with a username or password', () => {
    expect(isAllowedApiBase('https://a:b@x.com')).toBe(false)
    expect(isAllowedApiBase('https://user@x.com')).toBe(false)
  })

  it('rejects malformed and non-web addresses', () => {
    expect(isAllowedApiBase('not a url')).toBe(false)
    expect(isAllowedApiBase('')).toBe(false)
    expect(isAllowedApiBase('file:///c:/keys.txt')).toBe(false)
    expect(isAllowedApiBase('javascript:alert(1)')).toBe(false)
  })
})

describe('ConfigPatchSchema', () => {
  it('accepts an engine change', () => {
    expect(ConfigPatchSchema.safeParse({ translate: { engine: 'gemini' } }).success).toBe(true)
  })

  it('rejects an API base that is not allowed', () => {
    expect(ConfigPatchSchema.safeParse({ translate: { api: { baseUrl: 'http://evil.com' } } }).success).toBe(false)
  })

  it('rejects a Gemini model name that could break the URL', () => {
    expect(ConfigPatchSchema.safeParse({ translate: { gemini: { model: 'a/b?x' } } }).success).toBe(false)
  })
})
