// @ts-nocheck
// [ocrc-vendor-patch] 设置页扩展分区注册表（B9 批次 6a，2026-10-12）
//
// 上游设置页没有通用扩展点：分区硬编码在 settingsPageConfig，内容靠
// SettingsPage 的三元分支链选择，WorkspaceSettingsLayerProps 也没有
// children/slot/registry。ocrc 需要的 ocrc 域设置分区（模型映射方案库、
// 项目 .opencode/ 五件套、技能源注册、全局配置 raw 编辑）走这里注册。
//
// 形态与 PATCHES #10 的 i18n 品牌注册表同款——**模块级注册表**：
// 一处注册对全部 SettingsPage 实例（Root.tsx / WorkspaceSettingsLayer）生效，
// 免去逐实例 prop 透传；未来新增实例零成本继承。

export interface ZCodeSettingsExtraSectionContext {
  /** 当前工作区路径（设置页从 tab store 取；无工作区时为 null）。 */
  workspacePath?: string | null;
}

export interface ZCodeSettingsExtraSection {
  /** 分区 id（进 SettingsSectionId 守卫与 URL/意图记忆）。 */
  id: string;
  /** lucide 图标组件（与上游分区同款）。 */
  icon?: unknown;
  /** i18n 标题键（ocrc 侧经品牌注册表供给词条，零 vendor 词表改动）。 */
  titleId: string;
  /** 归属分组 id（用上游既有分组，避免扩 union）。 */
  groupId: string;
  /** 分区内容渲染（拿到设置页的上下文：工作区路径等）。 */
  render: (ctx: ZCodeSettingsExtraSectionContext) => unknown;
}

let extraSections: ZCodeSettingsExtraSection[] = [];

export function setZCodeSettingsExtraSections(
  sections: ZCodeSettingsExtraSection[] | null | undefined,
): void {
  extraSections = Array.isArray(sections) ? sections : [];
}

export function getZCodeSettingsExtraSections(): ZCodeSettingsExtraSection[] {
  return extraSections;
}
