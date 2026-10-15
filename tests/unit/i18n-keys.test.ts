import { describe, it, expect } from 'vitest'
import { en } from '../../src/transport/telegram/i18n/en.js'
import { zh } from '../../src/transport/telegram/i18n/zh.js'

/**
 * i18n 键一致性 — en/zh 两本词典必须覆盖完全相同的键路径。
 * 断言消息里列出缺失/多出的键，方便补译时直接对照。
 * 若未来真出现差异，先补齐文案再让本测试回绿；本测试只锁定键集，
 * 不锁定文案内容（那属于翻译质量问题，不在此校验）。
 */

type Dict = Record<string, unknown>

/** 递归展平嵌套对象为点路径集合（当前词典是扁平的，展平保证结构演进后测试仍成立）。 */
function flatten(obj: Dict, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'object' && value !== null ? flatten(value as Dict, path) : [path]
  })
}

/** 抽出 {placeholder} 令牌并排序拼接，用于 en/zh 插槽一致性比对。 */
function placeholders(text: string): string {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',')
}

const enKeys = flatten(en as Dict).sort()
const zhKeys = flatten(zh as Dict).sort()
const enSet = new Set(enKeys)
const zhSet = new Set(zhKeys)
const missingInZh = enKeys.filter((k) => !zhSet.has(k))
const missingInEn = zhKeys.filter((k) => !enSet.has(k))

describe('i18n dictionary key parity (en ↔ zh)', () => {
  it('en and zh expose exactly the same key set (recursive flatten)', () => {
    expect(
      missingInZh,
      `keys present in en but MISSING in zh (${missingInZh.length}):\n  ${missingInZh.join('\n  ')}`,
    ).toEqual([])
    expect(
      missingInEn,
      `keys present in zh but MISSING in en (${missingInEn.length}):\n  ${missingInEn.join('\n  ')}`,
    ).toEqual([])
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('both dictionaries are flat string maps (no duplicate drift in shape)', () => {
    for (const [key, value] of Object.entries(en as Dict)) {
      expect(typeof value, `en["${key}"] should be a string`).toBe('string')
    }
    for (const [key, value] of Object.entries(zh as Dict)) {
      expect(typeof value, `zh["${key}"] should be a string`).toBe('string')
    }
    expect(enKeys.length).toBe(zhKeys.length)
  })

  it('every key carries a non-empty translation in both locales', () => {
    const emptyEn = enKeys.filter((k) => !(en as Record<string, string>)[k]?.trim())
    const emptyZh = zhKeys.filter((k) => !(zh as Record<string, string>)[k]?.trim())
    expect(emptyEn, `en values empty at:\n  ${emptyEn.join('\n  ')}`).toEqual([])
    expect(emptyZh, `zh values empty at:\n  ${emptyZh.join('\n  ')}`).toEqual([])
  })

  it('{placeholder} slots match between en and zh for every key', () => {
    const mismatches: string[] = []
    for (const key of enKeys) {
      const enText = (en as Record<string, string>)[key] ?? ''
      const zhText = (zh as Record<string, string>)[key] ?? ''
      if (placeholders(enText) !== placeholders(zhText)) {
        mismatches.push(`${key}: en=[${placeholders(enText)}] zh=[${placeholders(zhText)}]`)
      }
    }
    expect(
      mismatches,
      `placeholder mismatch (${mismatches.length}) — interpolation would break at runtime:\n  ${mismatches.join('\n  ')}`,
    ).toEqual([])
  })
})
