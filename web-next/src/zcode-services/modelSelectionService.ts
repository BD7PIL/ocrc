// zcode-services/modelSelectionService.ts — ocrc-backed IModelSelectionService (N1).
// /api/models（provider→models 目录）+ /api/overrides（下一轮模型覆盖）映射进
// ZCode 的 ModelSelectionView。模型/Provider 的 config 对象按 UI 实际消费的
// 字段宽松 cast（RegistryModelConfigObject 是深层 zod 类型，完整重造不划算）。
import type { IModelSelectionService } from '@zcode/services'
import type { ModelSelectionView } from '@zcode/provider'

interface OcrcModel { id: string; name?: string; variants?: string[] }
interface OcrcProvider { id: string; name?: string; models: OcrcModel[] }
interface OcrcOverrides { model?: { providerID: string; modelID: string } | null; agent?: string }

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

let revision = 0

export function createOcrcModelSelectionService(): IModelSelectionService {
  const listeners = new Set<() => void>()
  return {
    // ZCode Event 契约（rpc foundation）：订阅返回 IDisposable 对象，不是裸函数
    onDidChange: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    getView: async (): Promise<ModelSelectionView> => {
      const [providers, overrides] = await Promise.all([
        getJson<OcrcProvider[]>('/api/models'),
        getJson<OcrcOverrides>('/api/overrides'),
      ])
      const list = providers ?? []
      revision += 1
      // overrides 未设置时默认首选 provider 的首个模型——否则 composer 判定
      // 「无可用模型」禁用发送（preferredSelection 是 effective 选择的来源）。
      const firstWithModels = list.find((p) => (p.models ?? []).length > 0)
      const preferred = overrides?.model ?? (firstWithModels
        ? { providerID: firstWithModels.id, modelID: firstWithModels.models[0].id }
        : undefined)
      const preferredVariant = preferred ? (list.find((x) => x.id === preferred.providerID)?.models ?? []).find((m) => m.id === preferred.modelID)?.variants?.[0] : undefined
      return {
        revision,
        effectiveSelection: preferred
          ? {
              providerId: preferred.providerID,
              modelId: preferred.modelID,
              options: preferredVariant ? { reasoningLevel: preferredVariant } : undefined,
            }
          : null,
        preferredSelection: preferred,
        providers: list.map((p) => ({
          providerId: p.id,
          providerName: p.name ?? p.id,
          templateId: p.id,
          config: {
            providerId: p.id,
            providerName: p.name ?? p.id,
            models: Object.fromEntries((p.models ?? []).map((m) => [m.id, { displayName: m.name ?? m.id }])),
          } as any,
          models: (p.models ?? []).map((m) => ({
            modelId: m.id,
            config: {
              displayName: m.name ?? m.id,
              // 校验入口 validateModelSelectionOptions 读 optionSpecs.reasoningLevel.values
              optionSpecs: { reasoningLevel: { values: m.variants ?? [] } },
              variants: m.variants ?? [],
            } as any,
          })),
        })),
      } as unknown as ModelSelectionView
    },
  } as unknown as IModelSelectionService
}
