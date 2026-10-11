// zcode-services/clientServices.ts — U4 幽灵清账·小件两枚。
//
// clientConfigService：上游语义 = 从 ZCode 云端拉「窗口级公开配置」（插件商店排序、
// zsrc 域名）。ocrc 无云端：静态快照（两键 null = vendor 语义的「无配置」），消掉
// 帮助菜单 URL / 商店排序两处 ghost reject。上云那天才需要真实现。
//
// clientScenesService：上游语义 = 客户端运营场景位（弹窗/横幅编排）。ocrc 无运营面：
// 空 scenes 列表。注意它**不能**置 undefined——useClientScenesResource 对 undefined
// 做 WeakMap.set 直接 TypeError（hooks/useClientScenesResource.ts:33-38）。
import type { IClientConfigService } from '@zcode/services'
import type { IClientScenesService } from '@zcode/services'

export function createOcrcClientConfigService(): IClientConfigService {
  return {
    getSnapshot: async () => ({ pluginStoreOrder: null, zsrcUrl: null }),
  }
}

export function createOcrcClientScenesService(): IClientScenesService {
  return {
    list: async () => ({ code: 0, msg: 'ok', data: [] }),
  }
}
