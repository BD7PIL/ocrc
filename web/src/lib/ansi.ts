const FG: Record<number, string> = {
  30: '#555', 31: '#e0796b', 32: '#6cc08b', 33: '#e0b341',
  34: '#7cafc2', 35: '#b48cf0', 36: '#4ec9b0', 37: '#f2f0ec',
  90: '#8d877c', 91: '#f09080', 92: '#8dd8a4', 93: '#f0c860',
  94: '#90c5dd', 95: '#c9a8f8', 96: '#70dcc8', 97: '#ffffff',
}

export function ansiToHtml(raw: string): string {
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  s = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (m) => (m.endsWith('m') ? m : ''))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')

  let open = 0
  const out: string[] = []

  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/)
    if (!m) { out.push(part); continue }

    const codes = m[1].split(';').filter(Boolean).map(Number)
    if (codes.length === 0) codes.push(0)

    const css: string[] = []
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) {
        // Reset: close open spans, then keep processing the rest of the
        // sequence (\x1b[0;31m = reset + red, not just reset).
        while (open > 0) { out.push('</span>'); open-- }
      } else if (c === 38 || c === 48) {
        // Extended colors: 38;5;n / 38;2;r;g;b (48 = background). Consume the
        // parameter bytes so they aren't misread as standalone SGR codes.
        const mode = codes[i + 1]
        if (mode === 5) {
          i += 2 // skip mode + palette index (256-color palette not mapped)
        } else if (mode === 2) {
          if (c === 38) css.push(`color:rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`)
          i += 4 // skip mode + r,g,b
        }
      } else if (c === 1) css.push('font-weight:bold')
      else if (c === 2) css.push('opacity:0.7')
      else if (c === 3) css.push('font-style:italic')
      else if (c === 4) css.push('text-decoration:underline')
      else if (FG[c]) css.push(`color:${FG[c]}`)
    }

    if (css.length) {
      out.push(`<span style="${css.join(';')}">`)
      open++
    }
  }

  while (open > 0) { out.push('</span>'); open-- }
  return out.join('')
}

export function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
}
