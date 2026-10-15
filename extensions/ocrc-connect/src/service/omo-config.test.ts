/** omo-config unit tests — batch 5.1. Injected-fs style like config-bridge:
 *  these are pure-function tests (script builders + parsers + validators),
 *  the ssh transport is exercised by the E4-stack integration. */
import { describe, expect, it } from 'vitest'
import {
  stripJsonc, parseOmoConfig, omoRemotePaths,
  buildOmoReadScript, parseOmoReadOutput, buildOmoWriteScript,
  summarizeOmoConfig, validateOmoWriteContent, applyOmoEdits,
  sanitizeOmoFallback, OMO_FALLBACK_DEFAULTS,
} from './omo-config.js'
import { OMO_SCHEMA } from './omo-schema.js'

describe('stripJsonc', () => {
  it('strips line comments but keeps string content', () => {
    const src = `{\n  // active preset\n  "preset": "openai", // trailing\n  "note": "keep // this and /* this */"\n}`
    const out = stripJsonc(src)
    expect(JSON.parse(out)).toEqual({ preset: 'openai', note: 'keep // this and /* this */' })
  })
  it('strips block comments across lines', () => {
    const src = `{\n/* head\n   comment */\n"a": 1\n}`
    expect(JSON.parse(stripJsonc(src))).toEqual({ a: 1 })
  })
  it('keeps escaped quotes inside strings', () => {
    const src = '{"s":"a \\"// not a comment\\" b"}'
    expect(JSON.parse(stripJsonc(src))).toEqual({ s: 'a "// not a comment" b' })
  })
})

describe('parseOmoConfig', () => {
  it('parses plain json', () => {
    expect(parseOmoConfig('{"preset":"openai"}', 'json').parsed).toEqual({ preset: 'openai' })
  })
  it('parses jsonc after stripping comments', () => {
    const r = parseOmoConfig('// c\n{"preset":"openai"}', 'jsonc')
    expect(r.parsed).toEqual({ preset: 'openai' })
  })
  it('rejects non-object documents', () => {
    expect(parseOmoConfig('[1,2]', 'json').err).toBeTruthy()
    expect(parseOmoConfig('null', 'json').parsed).toBeNull()
  })
  it('reports the parse error text for bad json', () => {
    expect(parseOmoConfig('{ nope', 'json').err).toBeTruthy()
  })
})

describe('remote paths + scripts', () => {
  it('assembles both candidate paths under $HOME', () => {
    const p = omoRemotePaths()
    expect(p.json).toBe('$HOME/.config/opencode/oh-my-opencode-slim.json')
    expect(p.jsonc).toBe('$HOME/.config/opencode/oh-my-opencode-slim.jsonc')
  })
  it('read script prefers jsonc and emits keyed headers', () => {
    const s = buildOmoReadScript(omoRemotePaths())
    expect(s).toContain('FORMAT:jsonc')
    expect(s).toContain('FORMAT:json')
    expect(s).toContain('FORMAT:missing')
  })
  it('read output parser decodes base64 body and size', () => {
    const body = Buffer.from('{"preset":"openai"}', 'utf-8').toString('base64')
    const out = parseOmoReadOutput(`FORMAT:json\nSIZE:18\n${body}`)
    expect(out.format).toBe('json')
    expect(out.size).toBe(18)
    expect(out.raw).toBe('{"preset":"openai"}')
  })
  it('write script backs up and writes atomically', () => {
    const { script, stdin } = buildOmoWriteScript('$HOME/.config/opencode/oh-my-opencode-slim.json', 'e30=')
    expect(script).toContain('P=\'$HOME/.config/opencode/oh-my-opencode-slim.json\'')
    expect(script).toContain('.ocrc-omo.')
    expect(script).toContain('cp -p "$P" "$P.ocrc-bak"')
    expect(script).toContain('mv "$T" "$P"')
    expect(stdin).toBe('e30=')
  })
})

describe('summarizeOmoConfig', () => {
  const doc = {
    $schema: 'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    preset: 'openai',
    presets: { openai: { orchestrator: { model: 'openai/gpt-6-sol' } }, 'opencode-go': { observer: {} } },
    fallback: { enabled: true, maxRetries: 2 },
  }
  it('missing file → exists:false with schema attached', () => {
    const s = summarizeOmoConfig('missing', undefined, undefined)
    expect(s.exists).toBe(false)
    expect(s.presetNames).toEqual([])
    expect(s.schema).toBe(OMO_SCHEMA)
  })
  it('json doc → presets sorted, active preset, fallback block', () => {
    const s = summarizeOmoConfig('json', 100, JSON.stringify(doc))
    expect(s.exists).toBe(true)
    expect(s.activePreset).toBe('openai')
    // Object.keys order — insertion order, not locale sort (sorted() was the
    // wrong expectation; summarize uses Object.keys(presets).sort() → locale compare)
    expect(s.presetNames).toEqual([...Object.keys(doc.presets)].sort())
    expect(s.fallback).toEqual({ enabled: true, maxRetries: 2 })
    expect(s.commentsWillBeLost).toBeFalsy()
  })
  it('jsonc doc flags comment loss', () => {
    const s = summarizeOmoConfig('jsonc', 100, '// c\n' + JSON.stringify(doc))
    expect(s.commentsWillBeLost).toBe(true)
    expect(s.parsed).toEqual(doc)
  })
  it('unparseable doc carries the error, not a throw', () => {
    const s = summarizeOmoConfig('json', 10, '{ broken')
    expect(s.parseError).toBeTruthy()
    expect(s.presetNames).toEqual([])
  })
})

describe('write validation + structured edits', () => {
  it('validateOmoWriteContent rejects bad json with 422-worthy error', () => {
    expect(validateOmoWriteContent('{ nope').ok).toBe(false)
    expect(validateOmoWriteContent('[]').ok).toBe(false)
  })
  it('validateOmoWriteContent canonicalizes good json', () => {
    const v = validateOmoWriteContent('{"preset":"openai"}')
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.canonical).toBe('{\n  "preset": "openai"\n}\n')
  })
  it('applyOmoEdits sets preset and merges fallback, preserving other keys', () => {
    const cur = { preset: 'openai', presets: { openai: {} }, extra: 'keep' }
    const next = applyOmoEdits(cur, { preset: 'opencode-go', fallback: { enabled: false } })
    expect(next).toEqual({ preset: 'opencode-go', presets: { openai: {} }, extra: 'keep', fallback: { enabled: false } })
  })
  it('applyOmoEdits clears preset (null) and removes fallback block (null)', () => {
    const cur = { preset: 'openai', fallback: { enabled: true }, presets: {} }
    const next = applyOmoEdits(cur, { preset: null, fallback: null })
    expect('preset' in next).toBe(false)
    expect('fallback' in next).toBe(false)
    expect(next.presets).toEqual({})
  })
})

describe('sanitizeOmoFallback', () => {
  it('accepts the schema defaults verbatim', () => {
    const r = sanitizeOmoFallback({ ...OMO_FALLBACK_DEFAULTS })
    expect(r.ok).toBe(true)
  })
  it('rejects negative / non-integer / wrong-type fields', () => {
    expect(sanitizeOmoFallback({ maxRetries: -1 }).ok).toBe(false)
    expect(sanitizeOmoFallback({ maxRetries: 1.5 }).ok).toBe(false)
    expect(sanitizeOmoFallback({ enabled: 'yes' }).ok).toBe(false)
  })
  it('rejects unknown fields (schema additionalProperties:false)', () => {
    const r = sanitizeOmoFallback({ nope: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err).toContain('nope')
  })
  it('rejects a bad continuationPolicy value', () => {
    expect(sanitizeOmoFallback({ continuationPolicy: 'yolo' }).ok).toBe(false)
    expect(sanitizeOmoFallback({ continuationPolicy: 'stick-to-fallback' }).ok).toBe(true)
  })
})
