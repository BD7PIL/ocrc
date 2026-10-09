# P2 实测记录：driver + host manager（隔离栈）

> 计划：workflow 全量落地 P2。环境：一次性 scratch（`/tmp/ocrc-p2`，自己的 stub 模型
> + 自己的引擎 + 自己的 host），**生产引擎（用户 :4096）与生产 ocrc 全程零接触**。
> 复现：`npm run build && node scripts/spikes/p2-workflow/gate.mjs`
> 结果：**30/30 通过**，6 份 journal 留在磁盘上。

## 结论表

| # | 计划门禁 | 结果 | 证据 |
|---|---|---|---|
| 1 | 3 actor 并行 | ✅ | `alpha,beta,gamma` 三个 actor 会话被铸出并落 journal，三个 ask 节点全 `completed` |
| 2 | 并发上限生效 | ✅ | cap=1 的 2-actor run：`node-dispatched@5 → node-settled@8 → node-dispatched@9`（第二条 ask 必须等第一条结算） |
| 3 | typed ask 一次通过 | ✅ | 提交 `{ok:true,reason:"looks good"}` → 引擎 accept → run `completed`，结果就是提交的值 |
| 4 | typed ask 被 repair 后通过 | ✅ | 先交 `{ok:"yes"}` → 引擎 reject（`$.ok: expected boolean, got string`）→ 节点仍 `running`（repair 轮在飞）→ 改交正确值 → accept → `completed` |
| 5 | world.read | ✅ | `world-read` 节点带 `input`（op+args 有界记录），`files.grep` 命中 1 条 |
| 6 | artifact | ✅ | `summary.v1` + `notes.v1` 落盘；HTTP 取回 `# Summary…`，`Content-Type: text/markdown`，`Cache-Control: immutable` |
| 7 | report | ✅ | `report` 节点落 journal，事件流里有 `report` |
| 8 | cancel → `stopped(user)` | ✅ | 慢 run 取消后 `status=stopped reason=user` |
| 9 | resume 从 journal 续跑到完成 | ✅ | 同 runId 再跑：事件流里第二轮 `run-started…run-settled`，终态 `completed` |
| 10 | 重启后可 resume | ✅ | 杀掉 host → 重启 → 在飞 run 被冷恢复成 `stopped(interrupted)` → resume 后 `completed` |
| 11 | 用量与预算闸 | ✅ | 每轮 usage 由引擎累加；`tokenBudget=10` 的 run 越线即停（`stopped`） |

事件流（fan-out run）覆盖了整条 Boundary C：`run-started / phase-entered /
actor-created / node-queued / node-dispatched / node-executing / usage-updated /
node-settled / world-read / report / artifact-published / run-settled`。

## 门禁自己修出的三处真缺陷

1. **driver 没绑进 live 表**（最关键）。`Live` 条目在 `makeDriver` 之前创建，于是
   `entry.driver` 一直是 `undefined`——relay 的 turn-end 打进来就 `TypeError:
   Cannot read properties of undefined (reading 'inFlightSessions')`，**所有 ask 永远
   停在 running**（第一版门禁：3 个 actor 全部 `running`，run 永不结算）。修法：
   entry 先建、driver 在工厂里就地回填。
2. **事件被写了两遍**。引擎自己已经 `journal.appendEvent` 再 `driver.emit` 扇出
   （engine.ts 明写「既落 journal 又经 driver.emit 扇出」），而 manager 的
   `emitEvent` 又 append 了一次——每行事件在 journal 里都是双份。修法：`emitEvent`
   只做实时扇出，绝不当第二个写入者。
3. **world/artifact 的根目录是 host 的 cwd，不是 run 的**。`artifact.file("notes",
   "NOTES.md")` 在 host 的工作目录里找文件 → `artifact.file source does not exist`。
   修法：`world.read(op,args,cwd?)` 与 `artifacts.publish(request,cwd?)` 接受 per-call
   根目录，driver 传它自己那份 run 的 cwd（一个 run 为别的目录起，就该在那边读写）。

## 两处如实标注的实现取舍

- **typed ask 的 submit 通道**：`submit_result` 是 actor 侧工具，属于 P3 的工具面。
  P2 门禁走的是同一条缝（`manager.submitFromSession`），用 `OCRC_WF_PROBE=1` 下的
  `POST /api/workflow/submit-probe` 送达——所以上面第 3/4 条验的是**引擎的裁决**
  （accept / reject+repair），不是工具的注册。P3 把工具接上同一条缝即可。
- **并发闸是两层**：引擎按 `caps.maxConcurrency` 排序派发（门禁第 2 条验的就是它），
  driver 另有一层 seat gate（报 `node-executing`，超限报 `node-waiting(cause:"slot")`），
  兜住引擎仍然交过来的 ask。上游的 AIMD provider 级控制器（`ConcurrencyController`）
  还没接——它管的是 provider 限流下的退避，不是 run 的座位数，留到 OPS 收口时按需接。
- **`world.run` 的人工门还没到**：`OCRC_WORKFLOW_RUN` 决定「一律拒绝」还是「放行并每次
  warn」，默认放行。P3 的审批卡接上后这里换成真门。

## 与计划的差异

计划 P2 的 manager 清单里有 `amend（含上游的 imported cache）`。P2 落的是
**amend 的骨架**（supersede + lineage 指针 + 新 run），**导入缓存没落**：它要读前驱
journal 重建「按 actor 名的已完成 ask 前缀 + world 节点队列 + 转录种子」，上游的构建器
住在 `bootstrap/app/dynamic-workflow-import.ts`（约 500 行，含 `quietSessions` 与
`messageBoundary` 记账）。这块与 `AmendWorkflow` 的工具面/UI（P3/P4）同批才有可观测的
价值，因此随 P4 落地；当前 amend 的行为是**重跑**（正确但更贵），已在代码注释与
`manager.amend` 的文档里写明。
