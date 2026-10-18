/**
 * 一台远程服务器的状态词与网络词——**面板与状态区共用一份**，两处不能各说各话。
 *
 * 版本与网络是这台机器自己的事实：版本取自实例自报（拿不到就写「未知」，不猜），
 * 网络取自出口决定（直连 / 经本机转发），没探测过就写「未探测」。
 */

export type StateTone = 'success' | 'warning' | 'error' | 'info' | 'neutral'

export interface StateLabel {
  label: string
  tone: StateTone
}

const STATE: Record<string, StateLabel> = {
  online: { label: '在线', tone: 'success' },
  starting: { label: '启动中', tone: 'info' },
  provisioning: { label: '安装中', tone: 'info' },
  checking: { label: '检查中', tone: 'info' },
  offline: { label: '已停止', tone: 'neutral' },
  disabled: { label: '已停用', tone: 'neutral' },
  unknown: { label: '未检查', tone: 'neutral' },
  error: { label: '出错', tone: 'error' },
}

/** 未知状态原样显示，不翻译成「没问题」。 */
export function stateLabel(state: string | undefined): StateLabel {
  return STATE[state ?? 'unknown'] ?? { label: state ?? '未知', tone: 'neutral' }
}

export function networkLabel(egress: { relay: boolean } | undefined | null): string {
  if (!egress) return '未探测'
  return egress.relay ? '经本机转发' : '直连'
}

/** 兼容档是给远程机器 glibc 挑的包，不是版本号——所以给人看的是它的意思。 */
export function tierLabel(tier: string | undefined): string {
  if (!tier) return '未判定'
  if (tier === 'legacy-glibc217') return '旧档（含重建的 node-pty）'
  if (tier === 'modern') return '常规档'
  return tier
}

/** 状态区用的是 CSS 类，不是 kit 的 tone 名——映射只此一处。 */
export const TONE_CLASS: Record<StateTone, string> = {
  success: 'oc-ok',
  info: 'oc-warn',
  warning: 'oc-warn',
  error: 'oc-err',
  neutral: 'oc-off',
}
