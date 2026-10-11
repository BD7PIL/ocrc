# VENDOR_BASELINE.md — vendor 快照基线登记

> 职责：回答「vendor 树现在是上游哪个版本、哪些文件是 ocrc 自己的」。升级时先改这里，再动手。
> 补丁清单见 [PATCHES.md](PATCHES.md)；逐组件验收见 [CHECKLIST.md](CHECKLIST.md)。

## 当前基线

| 项 | 值 |
|---|---|
| 上游仓库 | [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0） |
| 上游版本 | **v3.15.1**（squash 快照发布制：tag ≈ 上游 main 状态） |
| 快照对应上游 commit | **`aac4755`**（= tag v3.15.1，"feat: update to v3.15.1"，2026-10-11 取） |
| 导入提交 | ocrc Batch 2（2026-10-11；前一基线 v3.14.3/29628c9 于 ocrc `f07e665` 2026-10-07 导入） |
| 下一目标 | 跟随上游 tag；升级 = 覆盖七包 + [PATCHES.md](PATCHES.md) 重放 + 本文件改行 |

## vendored 包（web-next/vendor/zcode/，7 包）

`ui` · `provider` · `services` · `rpc` · `shared` · `model-option-map` · `cua`

- **装订约定**：只取源码与运行资产；**包级 `tsconfig.json` 不入树**（v3.15.1 起上游各包自带
  extends `../../tsconfig.base.json` 的 tsconfig——esbuild 会去读并炸在单仓根缺失上）。
- **cua 是部分 vendor**：整包平铺（`package.json` 版本 0.6.3），经 12 条 vite 子路径别名 +
  tsconfig paths 接线；`cua/**/*.d.ts` 不加 @ts-nocheck 横幅。
- **ui 包内部 `@/` 别名**指其自身 src（vite alias 通配）；`@/WebRemoteControlDialog.js` 由
  ocrc alias 精确覆盖（vite alias **先中先得**，必须排在通配之前——09247bf 教训）。
- **v3.15.1 新增前端依赖**（跟随上游 ui 包，装进 web-next）：`lottie-web@5.13.0`、
  `@modelcontextprotocol/{ext-apps,client,core}@2.0.0`。

## ocrc 新增文件（覆盖快照会丢，升级后从 git 恢复）

| 文件 | 引入 | 说明 |
|---|---|---|
| `ui/src/v4/sha256Pure.ts` | N8-4 | 纯 JS SHA-256（非安全上下文回退），71 行 |
| `ui/src/settings/RemotesSection.tsx` | N5 | 远程主机设置分区，223 行 |

## 第二棵 vendor 树

`vendor/zcode-dwf/`（**仓库根**，不在 web-next 下；dynamic-workflow 引擎，P1 引入，独立
[PATCHES.md](../../vendor/zcode-dwf/PATCHES.md)）——**升级时与主树同步**：覆盖
`apps/zcode-cli/packages/{dynamic-workflow,dynamic-workflow-runtime}` → 重放 2 行
workspace-import → 相对路径修复 → `node scripts/build-dwf.mjs` → dwf smoke 测试。
v3.15.1 引擎读面收紧（`listNodes/listActors/listEvents` opts 必填 + 新增
`countNodes/sumResultBytes/updateRunScript`）——宿主适配在 ocrc 侧
（`src/core/workflow/journal.ts` 的 JournalStorePort 实现），不是 vendor 修改。

## 升级操作序（约定）

1. 更新本文件基线行（版本 + commit + 导入提交号）。
2. 覆盖 7 包 → 恢复「ocrc 新增文件」两枚 → **删除各包 `tsconfig.json`** → 跑
   `node scripts/vendor-ts-nocheck.mjs`。
3. 按 PATCHES.md 逐条重放/再基底 → `npm run build`（模块图裁决新依赖）+ `npm test` +
   `npm run typecheck`（根 + web-next）→ dwf 同步 + build-dwf + smoke。
