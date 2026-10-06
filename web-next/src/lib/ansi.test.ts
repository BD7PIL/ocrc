import { describe, it, expect } from 'vitest'
import { ansiToHtml, stripAnsi } from './ansi.js'

describe('ansiToHtml', () => {
  it('applies a color that follows a reset in the same sequence (\\x1b[0;31m)', () => {
    const html = ansiToHtml('\x1b[0;31mred\x1b[0m plain')
    expect(html).toContain('<span style="color:#e0796b">red</span>')
    expect(html).toContain(' plain')
  })

  it('closes an open span when a reset arrives mid-stream', () => {
    const html = ansiToHtml('\x1b[32mgreen\x1b[0m plain')
    expect(html).toBe('<span style="color:#6cc08b">green</span> plain')
  })

  it('maps truecolor foreground (38;2;r;g;b) to an rgb color', () => {
    const html = ansiToHtml('\x1b[38;2;10;20;30mtext\x1b[0m')
    expect(html).toBe('<span style="color:rgb(10,20,30)">text</span>')
  })

  it('does not misread truecolor parameter bytes as SGR codes', () => {
    // 2 (dim/opacity) and 1 (bold) are parameters here, not style codes.
    const html = ansiToHtml('\x1b[38;2;1;2;3mtext\x1b[0m')
    expect(html).toBe('<span style="color:rgb(1,2,3)">text</span>')
    expect(html).not.toContain('opacity')
    expect(html).not.toContain('font-weight')
  })

  it('maps 256-color foreground (38;5;n) through the xterm palette', () => {
    // 196 = cube red; 4 = standard blue (FG[34]); 244 = grayscale.
    expect(ansiToHtml('\x1b[38;5;196mtext\x1b[0m')).toBe('<span style="color:rgb(255,0,0)">text</span>')
    expect(ansiToHtml('\x1b[38;5;4mtext\x1b[0m')).toBe('<span style="color:#7cafc2">text</span>')
    expect(ansiToHtml('\x1b[38;5;244mtext\x1b[0m')).toBe('<span style="color:rgb(128,128,128)">text</span>')
  })

  it('does not misread 256-color parameter bytes as SGR codes', () => {
    // 1 is the palette index (standard red), 32 the following SGR code.
    const html = ansiToHtml('\x1b[38;5;1;32mgreen\x1b[0m')
    expect(html).toBe('<span style="color:#e0796b;color:#6cc08b">green</span>')
    expect(html).not.toContain('opacity')
  })

  it('maps background color groups (48;5;n / 48;2;r;g;b)', () => {
    expect(ansiToHtml('\x1b[48;5;21mtext\x1b[0m')).toBe('<span style="background-color:rgb(0,0,255)">text</span>')
    expect(ansiToHtml('\x1b[48;2;1;2;3mtext\x1b[0m')).toBe('<span style="background-color:rgb(1,2,3)">text</span>')
  })

  it('still applies styles after a background group', () => {
    const html = ansiToHtml('\x1b[48;5;21;31mred\x1b[0m')
    expect(html).toBe('<span style="background-color:rgb(0,0,255);color:#e0796b">red</span>')
  })

  it('treats a bare \\x1b[m as reset', () => {
    const html = ansiToHtml('\x1b[31mred\x1b[m plain')
    expect(html).toBe('<span style="color:#e0796b">red</span> plain')
  })

  it('escapes HTML in the payload', () => {
    expect(ansiToHtml('\x1b[31m<b>\x1b[0m')).toBe('<span style="color:#e0796b">&lt;b&gt;</span>')
  })
})

describe('stripAnsi', () => {
  it('removes SGR and other escape sequences', () => {
    expect(stripAnsi('\x1b[0;31mred\x1b[0m \x1b[38;2;1;2;3mtrue')).toBe('red true')
  })
})
