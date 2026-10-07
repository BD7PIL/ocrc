# PATCHES.md — vendor 修改登记（re-vendor 时照单重放）

> 上游：zai-org/ZCode v3.14.3（快照 = 上游 main 2026-9-23 状态）。
> 修改纪律：加法优先（新组件/包装层放 vendor 之外）；确需改 vendor 文件时保持最小修改并在此登记。
> 重放流程：更新快照（git pull zai-org/ZCode → 覆盖 vendor/zcode/）→ 逐条重放下列修改 → 跑 `npm run build` 验证。

## 1. 全量 @ts-nocheck 横幅
- **文件**：所有 vendored `*.ts` / `*.tsx`（首行插入 `// @ts-nocheck`）
- **原因**：上游代码按其自身 tsconfig（无 verbatimModuleSyntax、宽松度不同）通过；我们的 tsc 配置更严，全量类型检查会产生海量噪音。@ts-nocheck 只静音类型错误，类型信息仍流入我们的代码（accessor 等消费 `IServiceAccessor` 等接口）。
- **重放脚本要点**：遍历 vendor 树，未以横幅开头的文件插入一行。

## 2. Root.tsx 摘除 OnboardingDialog 挂载
- **文件**：`vendor/zcode/ui/src/Root.tsx`（约 L1076–1090）
- **修改**：`<ScopedErrorBoundary scope="onboarding-dialog">…<OnboardingDialog …/></ScopedErrorBoundary>` 整块包在 `{false && ( … )}` 中（不卸载 import）。
- **原因**：ocrc 用 accessor 的 `onboardingRecordService`（shouldOnboard=false）标记引导完成；且该弹层关闭/卸载转换在 prod 触发 hook 顺序崩溃（areHookInputsEqual undefined deps，栈落在 useSettingsSync → useZCodeSessionService → useTabStore 链）。

## 3.（运行时行为，非文件 patch）上游缺陷修复沿用
- **vite.config.ts**：`worker.rollupOptions.treeshake: false`——上游 web/vite.config 同款修复（@pierre/diffs worker 入口缺 sideEffects 声明，生产 worker 子构建被摇成 0B → 池握手超时）。
