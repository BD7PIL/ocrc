// $lib/platform — app 层与壳之间的接缝（ZCode IPlatformService 寄存器）。
// web 实现全部 no-op/null；未来 Electron 壳提供窗口控制/目录选择/深链/更新
// 等真实现并注入。app 层只经此接口消费宿主能力——组件里禁止出现
// process/Electron/window.* 平台分支。

export type PlatformKind = 'web' | 'desktop'

export interface OcrcPlatform {
  kind: PlatformKind
  /** 系统目录选择框。web 返回 null（调用方回落到内建 DirectoryBrowser）。 */
  selectDirectory(): Promise<string | null>
}

export const webPlatform: OcrcPlatform = {
  kind: 'web',
  selectDirectory: () => Promise.resolve(null),
}

export let platform: OcrcPlatform = webPlatform

/** 壳启动时注入自身实现（web 默认值已在上方）。 */
export function setPlatform(p: OcrcPlatform): void {
  platform = p
}
