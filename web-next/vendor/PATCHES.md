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

## 4. 附件上传校验和：非安全上下文的纯 JS SHA-256 回退（N8-4）
- **文件**：`vendor/zcode/ui/src/v4/sha256Pure.ts`（新增）+ `vendor/zcode/ui/src/v4/attachmentUploadTransaction.ts`（`checksum()` 一处分支 + 一行 import）
- **修改**：`checksum()` 由「无 `crypto.subtle` 即抛 `fault.attachment.checksumUnavailable`」改为「有 subtle 走原生，否则回退 `sha256Hex()`（纯 JS，FIPS 180-4）」，返回格式不变（`sha256:<小写 hex>`）。
- **原因**：`crypto.subtle` 只在安全上下文（https/localhost）存在。ocrc 生产形态常是局域网 http 源（`http://192.168.x.x:4099/z/`），那里拖放/粘贴的附件（无 localPath，走 V4 上传事务）第一步就抛错、整条链断掉。零拷贝 localPath 路径本来就不算校验和，不受影响。
- **验证**：`web-next/src/zcode-services/__tests__/attachmentChecksum.test.ts` 对照 node `crypto` 逐长度比对（空/1B/55/56/63/64B/多 block/中文），并 stub 掉 subtle 走回退接线断言 `beginParams.checksum`。

## 5. 状态面板：已结束子代理单独开门（N8-5）
- **文件**：`vendor/zcode/ui/src/v4/ConversationStatusPanel.tsx`（面板级 early-return 一处条件）
- **修改**：`if (!model.hasContent && !canRenderEndedWorkflows) return null;` → 追加 `&& !canRenderEndedAgents`。
- **原因**：上游注释自认"Agents 的已结束行有同一个洞：`endedSubagentCount` 没进 `hasContent`"。后果：**只剩历史**的会话（opencode 不热重载，host 重启后打开旧会话就是这种）整个状态面板消失 → 子代理目录入口在旧会话里永远不可达。ocrc 的持久会话几乎都是这种形态。
- **验证**：隔离栈造一个已结束子会话 → /z/ 打开父会话 → 状态面板出现「已结束」入口 → 点击打开子代理目录面板并列出该子会话。
