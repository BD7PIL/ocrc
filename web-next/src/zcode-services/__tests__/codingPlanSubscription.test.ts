// codingPlanSubscriptionService 契约测试（P4-0）。
//
// 这个服务只有一个方法是真实现，但它决定整个 workflow 面在 /z/ 里是否可见：
// vendor 的 dynamicWorkflowAvailabilityStore 对**任何**异常都 fail-closed
// （catch → enabled:false），而原先 accessor 里根本没有这个服务字段，落到
// ghost Proxy 上方法必然 reject。所以这里钉两件事：
//   1. 快照必须是 alwaysOn/enabled:true，且 source 如实标 override（非远端下发）；
//   2. 其余方法仍然如实拒绝——不能因为填了一个方法就假装有订阅体系。
import { describe, it, expect } from 'vitest'
import { createOcrcCodingPlanSubscriptionService } from '../codingPlanSubscriptionService.js'
import { createGhostAccessor } from '../../zcode/accessor.js'

describe('codingPlanSubscriptionService (P4-0 workflow 总闸)', () => {
  it('reports the dynamic-workflow gate as enabled/alwaysOn', async () => {
    const svc = createOcrcCodingPlanSubscriptionService()
    const config = await svc.getDynamicWorkflowClientConfig()
    expect(config).toEqual({ mode: 'alwaysOn', enabled: true, source: 'override' })
  })

  it('accepts the forceRefresh argument the store passes', async () => {
    const svc = createOcrcCodingPlanSubscriptionService()
    await expect(svc.getDynamicWorkflowClientConfig({ forceRefresh: true })).resolves.toMatchObject({ enabled: true })
  })

  it('honestly refuses the subscription/payment surface', async () => {
    const svc = createOcrcCodingPlanSubscriptionService()
    await expect(svc.getStaticProducts()).rejects.toThrow(/尚未接入 ocrc/)
  })

  it('is wired into the accessor (ghost would reject → workflow UI hidden)', async () => {
    const accessor = createGhostAccessor() as unknown as Record<string, any>
    const config = await accessor.codingPlanSubscriptionService.getDynamicWorkflowClientConfig()
    expect(config.enabled).toBe(true)
  })
})
