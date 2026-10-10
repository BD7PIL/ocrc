// zcode-services/codingPlanSubscriptionService.ts — P4-0 前置开关。
//
// vendor 的动态工作流入口**全部**挂在这个服务的 getDynamicWorkflowClientConfig() 上：
// Root 的 loader 取一次快照写进 dynamicWorkflowAvailabilityStore，卡片、Resume/Configure
// 按钮、run 侧页、自动化页签里的 Saved Workflows 都读 enabled 位。取数失败 fail-closed
// （vendor 注释明写），而我们的 accessor 原先根本没有这个服务 → 落到 ghost Proxy →
// 方法直接 reject → 快照恒为 enabled:false → workflow 面在 /z/ 里全部隐藏。
//
// ocrc 没有 ZCode 账号体系，也没有远端灰度服务：workflow 在 ocrc 是**本地引擎能力**，
// 不是灰度下发的特性。所以这里如实回答 alwaysOn/override（override 语义 = 不来自远端，
// 观测字段就是为区分这两种情况而设的）。其余方法（订阅、支付、企业套餐……）一律
// ghost 语义如实拒绝，不假装有账号。
import { withGhosts } from './ghost.js'

/** 与 @zcode/shared 的 DynamicWorkflowClientConfig 同形；不 import 是为了不把
    vendor shared 的类型拉进这个薄层（services 里其余服务同样只依赖形状）。 */
interface DynamicWorkflowClientConfig {
  mode: 'disabled' | 'onDemand' | 'alwaysOn'
  enabled: boolean
  source: 'remote' | 'override' | 'default'
}

const DYNAMIC_WORKFLOW_CONFIG: DynamicWorkflowClientConfig = {
  mode: 'alwaysOn',
  enabled: true,
  source: 'override',
}

export function createOcrcCodingPlanSubscriptionService(): Record<string, any> {
  return withGhosts(
    'codingPlanSubscriptionService',
    {
      getDynamicWorkflowClientConfig: async (): Promise<DynamicWorkflowClientConfig> => DYNAMIC_WORKFLOW_CONFIG,
    },
    '（ocrc 无 ZCode 账号/订阅体系）',
  )
}
