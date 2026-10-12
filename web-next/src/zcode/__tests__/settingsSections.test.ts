// B9 批次 6a：vendor 设置页扩展分区插槽 + isSettingsSectionId 守卫修复的回归测试。
// 契约：
// ① 注册表注册的 ocrc 域分区进入 createSettingsPageConfig 的 sections 与分组；
// ② 分区 id 被导航守卫放行（旧 bug：union 里有 remotes、守卫里没有 → 写入可用、
//    读回被静默丢弃，「跳转意图」与「上次停留分区」双双失效）。
import { describe, it, expect, beforeEach } from 'vitest'
import { getZCodeSettingsExtraSections, setZCodeSettingsExtraSections } from '@zcode/ui'
import { createSettingsPageConfig } from '../../../vendor/zcode/ui/src/settings/settingsPageConfig.js'
import { readLastSettingsSectionPreference, setPendingSettingsSection } from '../../../vendor/zcode/ui/src/lib/settingsNavigation.js'
import { registerOcrcSettingsSections } from '../settingsSections.js'

const LAST_KEY = 'zcode-settings-last-section'

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear() } catch { /* jsdom */ }
  setZCodeSettingsExtraSections([])
})

describe('设置页扩展分区插槽', () => {
  it('① 注册后进入配置的 sections 与 agentCapabilities 分组', () => {
    registerOcrcSettingsSections()
    const ids = getZCodeSettingsExtraSections().map((s) => s.id)
    expect(ids).toEqual(['ocrcMapping', 'ocrcProject', 'ocrcSkillSources', 'ocrcGlobalConfig'])

    const cfg = createSettingsPageConfig({})
    for (const id of ids) {
      expect(cfg.settingsSections.some((s) => String(s.id) === id)).toBe(true)
    }
    const group = cfg.settingsSectionGroups.find((g) => g.id === 'agentCapabilities')
    expect(group?.sections.some((s) => String(s.id) === 'ocrcGlobalConfig')).toBe(true)
    // 上游分区不受影响
    expect(cfg.settingsSections.some((s) => String(s.id) === 'modelProvider')).toBe(true)
  })

  it('② 未注册时配置里不出现扩展分区（默认零侵入）', () => {
    const cfg = createSettingsPageConfig({})
    expect(cfg.settingsSections.some((s) => String(s.id) === 'ocrcMapping')).toBe(false)
  })
})

describe('isSettingsSectionId 守卫（remotes 漏项修复）', () => {
  it('「上次停留分区」= remotes 时如实恢复，不再静默回落 general', () => {
    window.localStorage.setItem(LAST_KEY, 'remotes')
    expect(readLastSettingsSectionPreference()).toBe('remotes')
  })

  it('扩展分区 id 同样被守卫放行（跳转意图不丢）', () => {
    registerOcrcSettingsSections()
    setPendingSettingsSection('ocrcMapping' as never)
    expect(readLastSettingsSectionPreference('ocrcMapping' as never)).toBe('ocrcMapping')
  })

  it('未知 id 仍回落到 fallback（守卫没有放松）', () => {
    window.localStorage.setItem(LAST_KEY, 'not-a-section')
    expect(readLastSettingsSectionPreference()).toBe('general')
  })
})
