# 命令批次调研：/skills · /ls · /open · /worktree（+/settings 押后记录）

日期：2026-09-26 ｜ 环境：opencode 1.18.32（spike 4598 真机验证）

## 0. 结论（TL;DR）

**四个命令全部可行，且全部有原生服务端数据面**——不需要进程内 fs/git 兜底，也不需要
等上游发版。唯一障碍是 `@opencode-ai/sdk` 生成物滞后（`skill`/`worktree` 组未生成），
插件侧用 fetch 直连 baseUrl 即可（项目里 web 通道已有同款先例）。

| 命令 | 服务端端点 | 真机验证 | 可行性 | 预估 |
|---|---|---|---|---|
| `/skills` | `GET /skill`（app.skills） | ✅ 返回真实技能清单（name+description） | 原生 | 0.5d |
| `/ls` | `GET /file?path=`（file.list）；模糊搜索 `GET /find/file?query=` | ✅ 返回 {name,path,absolute,type,ignored} | 原生 | 0.5d |
| `/open` | `GET /file/content?path=`（file.read） | ✅ 返回 {type:"text",content} | 原生 | 0.5d |
| `/worktree` | `GET/POST/DELETE /experimental/worktree` + `POST …/reset` | ✅ list 返回 []（空注册表，机制在） | 原生（experimental） | 1d |
| `/settings` | — | 押后：等 i18n 开关项齐备（用户裁决） | — | — |

## 1. 证据

`GET http://127.0.0.1:4598/doc`（OpenAPI，162 端点）中相关条目；以上四个组均带
`directory`/`workspace` query 参数（多工作区语义与我们 SessionState 的
activeWorkspace 对齐）。

SDK 缺口确认：`@opencode-ai/sdk` dist 里无 `skill`/`worktree` 任何符号（file 组在）。
→ **决策：backend 扩展走原始 fetch**，不升级 SDK（升级有全局 API 漂移风险，红线期不做）。

附带发现（顺带登记，不扩scope）：
- 事件总线里有 **`EventTodoUpdated`** —— PlanHud/TaskPanel 日后可从"feed seq 去抖重拉"
  升级为精确推送；本批不动。
- `GET /vcs`、`/vcs/status`（分支+git 状态）可作后续 /git 类命令储备。
- 注意：`Project.worktree` 字段是"项目根目录"，与 /experimental/worktree（沙箱工作树
  注册表）是两回事，文档代码注释里要写清，防混。

## 2. 设计

### 2.1 backend 接口扩展（`src/core/agent/backend.ts`）

```ts
capabilities: { skills?: boolean; files?: boolean; worktrees?: boolean }  // 新增三闸
listSkills(project: string): Promise<SkillInfo[]>            // {name, description}
listFiles(project: string, path: string): Promise<FileEntry[]> // {name,path,type}
readFile(project: string, path: string): Promise<string>      // 截断到预算内
listWorktrees(project: string): Promise<WorktreeInfo[]>       // experimental
```

opencode-backend 实现：fetch `${baseUrl}/skill|/file|/file/content|/experimental/worktree`
（directory 取当前 activeWorkspace）。capabilities 探测：`GET /skill` 200 → skills=true；
`/experimental/worktree` 200 → worktrees=true（experimental 端点可能整个 404，探测降级）。

ACP/V2 backend：默认三闸 false（`can` 语义：显式 false 才隐藏 → 这里必须**显式**
返回 false，避免 UI 误亮）。

### 2.2 TG UX（挂进现有 26 命令菜单 → 30 个）

- `/skills`：inline 列表（名称+一句话描述，10/页翻页）。点按 → 把"用 xx 技能做…"
  填入输入建议（不直接执行，与 C2 chips 语义一致）。
- `/ls [path]`：inline 目录列表（📁/📄 前缀，10/页，`..` 上级）。点文件 → 发 content
  预览卡（截 800 字符 + 行数统计，附 "在 web 打开" 按钮）。
- `/open <path>`：直接读文件 → 预览卡（MarkdownV2 代码块降级链照旧）。
- `/worktree`：experimental 闸内 —— 列表（分支+路径+📍当前）+ 新建（输入分支名，
  走 RenameManager 同款 interaction 输入流）+ 删除/reset 二次确认。experimental 命名
  空间在菜单里标注 `beta`。

### 2.3 web（非本批必需，登记）

- `/ls`+`/open` 的 web 对应物是 Inspector 文件浏览器——已有 WorkingDirPanel（改动
  文件视角），不做通用浏览器，避免与桌面端职责重叠。

### 2.4 /settings（押后，用户裁决记录）

内容预案（等 i18n 开关项齐）：语言 locale 切换、建议 chips 开关、后台会话通知开关、
定时任务入口。依赖到位前不实现。

## 3. 风险

1. `/experimental/worktree` 语义不稳：全程 capabilities 探测 + beta 标注 + 只在
   B_bot 隔离环境验证；reset/create 不在生产 4096 上测试（红线）。
2. 大文件：/open 读取截断（800 字符预览 + 全文走 web）；二进制 type≠text 直接拒。
3. 路径越权：file endpoints 天然以 directory 限定 workspace；TG 侧再校验 path 不出
   activeWorkspace（`..` 规范化后前缀校验）。
4. 菜单膨胀：26→30 命令，setMyCommands 三 scope 刷新照旧；帮助文案分组。

## 4. 排期建议（M8）

- M8a backend 扩展+探测闸（0.5d）
- M8b TG /skills /ls /open（1d）
- M8c TG /worktree beta（1d，可与 M8b 并行）
- 验收：B_bot 真机四命令闭环 + V1 回归子集（收发/三键/pair）+ spike OpenAPI 快照入库
  （tests/fixtures/openapi-1.18.32.json，防上游漂移）。

## 附记（2026-09-28）：/question 端点批次已实施（M10）

`/question` 组三端点已从调研转为落地（`docs/parity-audit-2026-09-27.md` 附录 3 C 节）：
`GET /question?directory=`、`POST /question/{id}/reply`（body `answers: string[][]`，
每题一组原始 label）、`POST /question/{id}/reject`；事件 `question.asked/replied/
rejected` **只经 `/global/event` SSE 广播，V1 插件 event hook 收不到**（实证），
插件侧已补专用 SSE 转发。SDK 1.17.13 无 question 符号（raw fetch 解决）。
`question.updated` 之类事件不存在——生命周期就是 asked → replied/rejected。
