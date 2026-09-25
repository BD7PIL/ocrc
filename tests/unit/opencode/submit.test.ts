// tests/unit/opencode/submit.test.ts — prompt body assembly (pure).
import { describe, it, expect } from 'vitest'
import { buildPromptBody } from '../../../src/opencode/submit.js'

describe('buildPromptBody', () => {
  it('builds a text-only body', () => {
    const body = buildPromptBody({ text: 'hello' })
    expect(body.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(body).not.toHaveProperty('agent')
    expect(body).not.toHaveProperty('model')
  })

  it('attaches agent and model overrides when present', () => {
    const body = buildPromptBody({
      text: 'x',
      agent: 'reviewer',
      model: { providerID: 'p', modelID: 'm' },
    })
    expect(body.agent).toBe('reviewer')
    expect(body.model).toEqual({ providerID: 'p', modelID: 'm' })
  })

  it('appends one file part per image with an inline data URL', () => {
    const body = buildPromptBody({
      text: 'what is this?',
      images: [{ data: 'QUJD', mimeType: 'image/png' }],
    })
    expect(body.parts).toHaveLength(2)
    const file = body.parts[1] as Record<string, string>
    expect(file.type).toBe('file')
    expect(file.mime).toBe('image/png')
    expect(file.filename).toBe('image.png')
    expect(file.url).toBe('data:image/png;base64,QUJD')
  })

  it('honors explicit filenames and derives extensions from the mime type', () => {
    const body = buildPromptBody({
      text: 'x',
      images: [
        { data: 'a', mimeType: 'image/jpeg', filename: 'photo.jpg' },
        { data: 'b', mimeType: 'image/webp' },
      ],
    })
    expect((body.parts[1] as Record<string, string>).filename).toBe('photo.jpg')
    expect((body.parts[2] as Record<string, string>).filename).toBe('image.webp')
  })

  it('no images → identical to the legacy text-only shape', () => {
    const body = buildPromptBody({ text: 'x', images: [] })
    expect(body.parts).toEqual([{ type: 'text', text: 'x' }])
  })
})
