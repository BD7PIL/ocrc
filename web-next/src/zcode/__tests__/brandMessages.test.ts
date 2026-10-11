// brandMessages.test.ts — U2 品牌层守恒校验：
// ① 覆盖值不含 "ZCode" 字样（品牌残留 = 破功）；② 占位符集合与 vendor 原词条
// 严格守恒（破坏 {placeholder} 会让上游运行时替换出空洞）；③ 覆盖键在 vendor
// 词表里真实存在（拼错的 key 是静默死覆盖）。
import { describe, expect, it } from 'vitest'
import { BRAND_MESSAGES } from '../brandMessages.js'
import zhCN from '../../../vendor/zcode/ui/src/i18n/locales/zh-CN.js'
import enUS from '../../../vendor/zcode/ui/src/i18n/locales/en-US.js'

const TABLES: Record<string, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'en-US': enUS as Record<string, string>,
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort()
}

describe('BRAND_MESSAGES', () => {
  it('覆盖值零 "ZCode" 残留（不区分大小写）', () => {
    for (const [locale, map] of Object.entries(BRAND_MESSAGES)) {
      for (const [key, value] of Object.entries(map!)) {
        expect(/zcode/i.test(value), `${locale}/${key} = ${value}`).toBe(false)
      }
    }
  })

  it('每个覆盖键都在 vendor 词表里存在', () => {
    for (const [locale, map] of Object.entries(BRAND_MESSAGES)) {
      const table = TABLES[locale]!
      for (const key of Object.keys(map!)) {
        expect(table[key], `${locale}/${key} 不在 vendor 词表`).toBeTruthy()
      }
    }
  })

  it('占位符与 vendor 原词条守恒', () => {
    for (const [locale, map] of Object.entries(BRAND_MESSAGES)) {
      const table = TABLES[locale]!
      for (const [key, value] of Object.entries(map!)) {
        expect(placeholders(value), `${locale}/${key} 占位符漂移`).toEqual(placeholders(table[key] ?? ''))
      }
    }
  })
})
