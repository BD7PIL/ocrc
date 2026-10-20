import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, stripJsonc } from '../../src/utils/jsonc.js'
import { generateSecret } from '../../src/utils/secret.js'

/**
 * `src/utils` — the small extraction survivors. Each of these used to live
 * inside a bigger deleted module; the tests pin the properties the callers
 * actually rely on (string-safe comment stripping, URL-safe secrets, the
 * OCRC_HOME override).
 */

describe('stripJsonc', () => {
  it('drops line comments, block comments and trailing commas', () => {
    const text = [
      '// leading note',
      '{',
      '  "a": 1, // trailing note',
      '  /* block',
      '     spanned */ "b": 2,',
      '  "arr": [1, 2,],',
      '}',
    ].join('\n')
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 1, b: 2, arr: [1, 2] })
  })

  it('never treats // or quotes inside a string as syntax', () => {
    expect(JSON.parse(stripJsonc('{"url": "http://x/y//z", "q": "a\\"b"}'))).toEqual({
      url: 'http://x/y//z',
      q: 'a"b',
    })
    // An escaped backslash before a quote must not end the string early.
    expect(JSON.parse(stripJsonc('{"p": "C:\\\\path//not-comment"}'))).toEqual({ p: 'C:\\path//not-comment' })
  })

  it('keeps a bare text unchanged', () => {
    expect(stripJsonc('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseConfig', () => {
  it('parses a commented config into an object', () => {
    expect(parseConfig('// c\n{ "model": "a/b", }')).toEqual({ ok: true, parsed: { model: 'a/b' } })
  })

  it('rejects a non-object top level and bad JSON with the parser message', () => {
    expect(parseConfig('[1,2]').ok).toBe(false)
    expect(parseConfig('42').ok).toBe(false)
    const bad = parseConfig('{ oops }')
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
  })
})

describe('generateSecret', () => {
  it('is URL-safe base64 of 18 bytes (24 chars, no +/=), and unique', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const s = generateSecret()
      expect(s).toMatch(/^[A-Za-z0-9_-]{24}$/)
      seen.add(s)
    }
    expect(seen.size).toBe(50)
  })
})

describe('ocrcHome', () => {
  it('honours the OCRC_HOME override (this is what keeps tests out of the real ~/.ocrc)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ocrc-home-'))
    const saved = process.env.OCRC_HOME
    try {
      process.env.OCRC_HOME = home
      const { ocrcHome } = await import('../../src/utils/paths.js')
      expect(ocrcHome()).toBe(home)
    } finally {
      process.env.OCRC_HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.ocrc when the override is unset', async () => {
    const saved = process.env.OCRC_HOME
    delete process.env.OCRC_HOME
    try {
      const { ocrcHome } = await import('../../src/utils/paths.js')
      expect(ocrcHome()).toBe(join(await import('node:os').then((m) => m.homedir()), '.ocrc'))
    } finally {
      process.env.OCRC_HOME = saved
    }
  })
})
