# VENDOR_BASELINE.md — vendor 快照基线登记

> 职责：回答「vendor 树现在是上游哪个版本、哪些文件是 ocrc 自己的」。升级时先改这里，再动手。
> 补丁清单见 [PATCHES.md](PATCHES.md)；逐组件验收见 [CHECKLIST.md](CHECKLIST.md)。

## 当前基线

| 项 | 值 |
|---|---|
| 上游仓库 | [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0） |
| 上游版本 | **v3.14.3**（squash 快照发布制：tag ≈ 上游 main 状态，本仓库仅 4 个提交量级） |
| 快照对应上游 commit | `29628c9`（上游 main 2026-09-23 状态） |
| 导入提交 | ocrc `f07e665`（2026-10-07，N0） |
| 下一目标 | **v3.15.1** = tag `aac4755`（单 squash commit，计划批次 2） |

## vendored 包（web-next/vendor/zcode/，7 包）

`ui` · `provider` · `services` · `rpc` · `shared` · `model-option-map` · `cua`

- **cua 是部分 vendor**：只取 broker 子路径（`package.json` 版本 0.6.3），经 12 条 vite/tsconfig 子路径别名接线（见 `vite.config.ts` + `tsconfig` paths）；`cua/*.d.ts` 不加 @ts-nocheck 横幅。
- **ui 包内部 `@/` 别名**指其自身 src（PATCHES 条目 1 横幅 + vite alias 通配）；`@/WebRemoteControlDialog.js` 由 ocrc alias 精确覆盖（vite alias **先中先得**，必须排在通配之前——09247bf 教训）。

## ocrc 新增文件（覆盖快照会丢，升级后从 git 恢复）

| 文件 | 引入 | 说明 |
|---|---|---|
| `ui/src/v4/sha256Pure.ts` | N8-4 | 纯 JS SHA-256（非安全上下文回退），71 行 |
| `ui/src/settings/RemotesSection.tsx` | N5 | 远程主机设置分区，223 行 |

## 第二棵 vendor 树

`vendor/zcode-dwf/`（dynamic-workflow 引擎，P1 引入，独立 [PATCHES.md](zcode-dwf/PATCHES.md) 2 条 + `scripts/build-dwf.mjs`）——**升级时与主树同步**（批次 2）。

## 升级操作序（约定）

1. 更新本文件基线行（版本 + commit + 导入提交号）。
2. 覆盖 7 包 → 恢复「ocrc 新增文件」两枚 → 跑 `node scripts/vendor-ts-nocheck.mjs`。
3. 按 PATCHES.md 逐条重放/再基底 → `npm run build` + `npm test` + `npm run typecheck`。
