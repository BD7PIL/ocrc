# PATCHES.md — vendored dwf 引擎的修改登记（re-vendor 时照单重放）

> 上游：zai-org/ZCode v3.14.3（快照 = 上游 main 2026-9-23 状态）。
> 快照来源路径：`apps/zcode-cli/packages/{dynamic-workflow,dynamic-workflow-runtime}`。
> 修改纪律：加法优先；确需改 vendor 文件时保持最小修改并在此登记。
> 重放流程：更新快照（覆盖 `vendor/zcode-dwf/dynamic-workflow{,-runtime}/`）→ 逐条重放下列
> 修改 → `node scripts/build-dwf.mjs` → `npx vitest run tests/unit/vendor-dwf-smoke.test.ts`。

## 1. 跨包 import 改为相对路径（唯一一处源码改动）
- **文件**：`dynamic-workflow-runtime/src/{harness.ts,protocol.ts}`
- **修改**：`from "@zcode/dynamic-workflow"` → `from "../../dynamic-workflow/src/index.js"`。
- **原因**：上游是 monorepo workspace 包（`"@zcode/dynamic-workflow": "workspace:*"`），裸
  specifier 由 pnpm 的 workspace 链接解析。我们不带包管理器链接，只用一次 tsc 把两包编到
  同一棵 `dist/` 里，因此改成相对路径——同一路径在 `src/` 与 `dist/` 下**深度一致**
  （都是 `dynamic-workflow-runtime/src/ → ../../dynamic-workflow/src/`），编译产物无需任何
  运行时改写即可解析。
- **重放**：两行字符串替换（`harness.ts` 的 import 块尾、`protocol.ts` 的类型 import）。

## 2. 构建布局：一次 tsc 编两包
- **文件**：`vendor/zcode-dwf/tsconfig.build.json`（我们新增；上游每包各一份 tsconfig.json，
  已随快照保留但**不用于我们的构建**）
- **原因**：`rootDir: "."` + `outDir: "./dist"` 让产物保持
  `dist/dynamic-workflow/src/…` 与 `dist/dynamic-workflow-runtime/src/…` 的兄弟关系，
  于是 #1 的相对路径在产物里依然成立。用上游各自的 tsconfig 分两次编译会得到两棵互不可见的
  dist 树，相对路径失效。
- **注意**：`scripts/build-dwf.mjs` 先跑上游 `scripts/generate-libs.mjs`（把 TypeScript 标准库
  `.d.ts` 闭包嵌进 `src/compiler/libs.generated.ts`——workflow 编译器按设计零磁盘访问，不能
  在运行时去读 `lib.es2022.d.ts`）。该脚本幂等，按已装 TS 版本判断是否重写。

## 3. 非改动但必须记录的两条依赖事实

### 3.1 `typescript` 是**运行时**依赖（不是 devDependency）
`dynamic-workflow/src/analysis/**` 与 `compiler/**` 共 20+ 处 `import ts from "typescript"`：
编译、类型解析、schema 合成、lowering 全在 TS 编译器 API 上跑。因此根 `package.json` 把
`typescript` 从 devDependencies 提到 dependencies（上游同款：`"typescript": "^5.9.0"`）。
代价：包体 +约 7 MB，且只在 workflow 编译路径被 import。

### 3.2 zod 不参与
本引擎对 `zod` **零依赖**：facade 的 schema 是自研 JSON Schema 发射器
（`src/schema/emit.ts`，`artifact-spec.ts` 里明写「为什么是手写而不是 zod：本包零运行时依赖」）。
上游 `shared` 侧另有一份 zod 镜像，我们不 vendor。故我们的 `zod@^4.6.5` 与本引擎无耦合，
升级 zod 不影响它；反之亦然。冒烟测试用 `src/schema/validate.ts` 校验合成结果，走的就是
引擎自己那条校验路径。

## 4. 未 vendor 的上游部分（有意）
- `dynamic-workflow/scripts/generate-mermaid.mjs`（`charts` 脚本）——只生成图表产物，
  构建路径不需要，留在上游。
- `dynamic-workflow/scratch/`、`.oxlintrc.json`、各包 `.gitignore`——开发脚手架。
- `dynamic-workflow/src/projections.ts` 等图表投影：**已随快照包含**（`/z/` 的因果图会用到）。
