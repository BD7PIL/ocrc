# P3 实测记录：工具面 + 技能门（模型端到端）

> 计划：workflow 全量落地 P3。环境：一次性 scratch（`/tmp/ocrc-p3`）= **host(4199)
> + 装插件的引擎(4295, ATTACHED) + 脚本化 stub 模型(4300)**。生产引擎 :4096 与生产
> ocrc 全程零接触；所有子进程 env 都清空 Telegram 凭据。
> 复现：`npm run build && node scripts/spikes/p3-tools/gate.mjs` → **14/14 通过**。

## 结论表（计划 a–g）

| 项 | 计划要求 | 结果 | 证据 |
|---|---|---|---|
| a | 模型读到技能 | ✅ | 作者会话的 transcript 里有 `Writing dynamic workflows`（技能正文经 `GetWorkflowSkill` 回到模型） |
| b | 模型写出 2-actor fan-out 脚本并起 run | ✅ | transcript 里有 `dwfrun-577a9e75…`；host 上该 run `completed`，`actors=2 nodes=3` |
| c | 故意写错拿诊断并改对 | ✅ | `EvalWorkflowSnippet` 回 `TS2322 Type 'number' is not assignable to type 'string'.`（带 `L3:C7`）；随后用改对的脚本起 run |
| d | 审批后启动 | ⚠️ 部分 | 「工具是唯一入口」已验（坏脚本 `no run was created`，host 上没有 run 行）；**world.run 的人工审批门还没做**（见下） |
| e | actor 的 typed submit 被接受 | ✅ | 向 actor 会话投 `submit_result` → `{"ok":true}`；typed run 随后 `completed`，`result={"ok":true}` |
| f | 用 GetWorkflowRun 汇报进度 | ✅ | transcript 里渲染出 `dwfrun-…  completed` 列表 |
| g | ResolveWorkflowQuestion 答掉一次 escalate | ✅ | `escalate` → `answer:null` + 让 actor 自行判断；`/escalations/answer` 后重问 → `answer:"staging"` |

## 工具面（模型看到的 16 个工具）

引擎侧实测的 id 列表：
`… rc-status, notify, schedule_create, schedule_list, wf_echo, GetWorkflowSkill,
EvalWorkflowSnippet, CreateWorkflow, AmendWorkflow, GetWorkflowRun, ListWorkflowRuns,
ResumeWorkflowRun, SaveWorkflow, ListSavedWorkflows, submit_result, escalate,
ResolveWorkflowQuestion`。

作者侧与 actor 侧在同一个工具集里，因为一个引擎会话既是写 workflow 的地方，也是它
的子代理跑的地方。全部是打回 host 的薄 HTTP 调用、全部无状态（run id 由 host 分配）。

## 两处承重设计（都来自上游）

1. **技能门**：四个创建类工具在本会话未加载 `dynamic-workflows` 技能前直接拒绝，并把
   加载方式写进拒绝文本。开门两条路——`GetWorkflowSkill` 工具，以及 opencode 官方
   `skill` 工具的 `tool.execute.before` 钩子（上游那条路）。门按会话记。
   技能正文 vendor 自上游 `bundled-skills`（SKILL.md 1520 行 + patterns 460 +
   examples 801），只有一份副本，由 host 的 `GET /api/workflow/skill` 供出。
2. **编译反馈是一等工具**：`EvalWorkflowSnippet` 只编译不建 run，回带行列的诊断——
   门禁 c 验的就是这条便宜迭代路径。

## 还没做的（如实标注）

- **`world.run` 的人工审批门**。现在 `OCRC_WORKFLOW_RUN` 只提供「一律拒绝」或「放行并
  每次 warn」，默认放行。计划里「审批（复用现有审批卡 + TG 按钮 + allowAlways 记忆，
  带因果图）」尚未落地——这是 P3 唯一没做完的一块，也是 `d` 只能算部分通过的原因。
- **`escalate` 的 UI 面**：问题与答案现在只在 HTTP/工具层流通（`GetWorkflowRun` 会列出
  待答项），面板里的问答入口随 P4 的投影一起做。
- **P3 门禁的模型是脚本化的**。它证明的是**管道**（工具注册、门、编译反馈、run 生命周期、
  submit、escalate），不是「某个真实模型写得出好脚本」——后者是模型质量问题，不是接线
  问题。真实模型的验收要在用户的模型上跑（P5 的运维件里留了步骤）。
