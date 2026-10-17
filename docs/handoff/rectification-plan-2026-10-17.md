# OCRC 整改方案（2026-10-17）

依据：`docs/research/openchamber-source-review-2026-10-17.md`（源码复盘）+ 本轮配对路径实测。
原则：**上游已经做完的，一律不重做；我们只保留上游做不了的那一层。**

---

## 0. 一句话

把"连接与身份"整层交还 openchamber（配对链接 → 每设备可撤销 token），OCRC 收缩为
**给"自己装不上 openchamber"的机器供货**那一层；同时删掉我们为重复实现而写的全部代码。

---

## 1. 为什么整改（三条已证事实）

1. **上游的连接层完整且更安全**：一次性链接 → 每设备独立 token（可撤销、无过期、与 UI 密码分离）。
   本轮实测：链接在 10 秒内被 app 兑换，对端签发 `auth=pairing` 的 client，app 把它当服务器用，
   而 `desktopSshInstances` **全程为空**——我们写桌面列表这件事本身就是多余的。
2. **上游的安装路径覆盖不到我们的目标机器**：managed 模式在**对端**跑 `npm/bun install`。
   断网实测：DNS 三跳 ENOTFOUND → 回落五个月旧缓存 → `ETARGET`。glibc 2.17 对端也没有可用 Node。
   所以 CI 两档包 + 推送仍是唯一通路。
3. **我这两天的交付方法有系统性缺陷**：在 minified bundle 上 grep，没命中就下结论（两次错），
   且从没走过用户路径。交付物"技术上成立、使用上不成立"。

---

## 2. 整改项

### P1 连接层：改为上游配对链接（核心）
- **现状**：`ocrc remote connect --desktop-add` 往桌面版 `settings.json` 写 `desktopSshInstances`；
  面板给「复制三项」，由人填三个字段。
- **问题**：重复实现上游能力，且比它差（要填字段、要手输 UI 密码、我们还要维护别人的配置文件）。
- **改法**：装好并启动对端后，由扩展 service **自持 `-L`**（`127.0.0.1:<localPort> → 对端:<instancePort>`），
  在对端跑 `connect-url --port <实例端口> --server http://127.0.0.1:<localPort> --name <标签>`，
  面板给出链接 + 「打开」（走 `openchamber://` 深链，app 自己弹确认）/「复制」。
- **状态**：**bridge 已完成并实测**（`pairLink()` 自起转发 + 取回链接，6 项单测通过）。
  面板按钮与 ops 待接。
- **验收**：从面板点一次 → app 弹确认 → 点确认 → 对端出现在 app 服务器列表且能打开项目/会话。

### P2 删除"写桌面版配置"整块
- **现状**：`src/core/desktop-settings.ts` + `--desktop-add` + 「复制三项」+ 相关测试与文档。
- **问题**：它是为 P1 的旧做法存在的；写别人的配置文件还带来真实风险（我昨天修的合并 bug 就是
  它静默删掉用户刚存的 SSH 密码）。
- **改法**：整个模块与调用点删除（P1 落地后）。
- **验收**：`grep -r desktop-settings src/ extensions/` 为空；门禁全绿；P1 的验收仍成立。

### P3 status 区：旧面与新面统一
- **现状**：status 区是批次 2 的 profile/隧道读数（`/connect`、`/disconnect`、`/status`，显示"隧道/未连"），
  与实例面（对端/预演/装机/启动）不是一套；空状态下它就是死的。
- **改法**：status 区改读实例状态（复用面板的 `state/引擎/node` 徽标），或直接去掉，只留面板。
- **验收**：重置状态下不再显示"隧道 未连"；有实例时显示与面板一致的状态。

### P4 面板补日志入口
- **现状**：service 已有 `logs` op，面板没有按钮（用户看不到安装/隧道日志）。
- **改法**：每行加「日志」，展开显示 `manager.logs(id)`。
- **验收**：装机后能看到日志尾部。

### P5 凭据政策收窄
- **现状**：本轮同意"允许明文 SSH 密码"，OPS 写成了通用政策。
- **改法**：明确收窄为**上游原生 SSH 实例那条路的事，我们不碰**；我们自己的路径
  （`plan/apply/up/probe`）继续 key-only；对端 UI 密码保持 `store:"never"`；
  配对链接给的是**每设备可撤销 token**，比存密码更好，所以 P1 落地后我们不需要任何密码存储。
- **验收**：OPS 的凭据段与实际代码一致；`grep -r sshPassword src/` 只出现在 desktop-settings（将被删）。

### P6 文档对齐
- **现状**：OPS 里仍有 `--desktop-add` 步骤；handoff 里有"只走 key、不支持密码"的过期声明。
- **改法**：OPS 的接入步骤整段改为"配对链接"；handoff 标为历史；`AGENTS.md` 补一行定位
  （OCRC = 供货层，连接归上游）。
- **验收**：按 OPS 步骤能从零走通，不需要任何 CLI 命令。

### P7 工作方法整改（防复发）
- 说"上游没有 X"之前，必须读**源码**（`packages/`）而不是打包产物，且**两个 bundle 都翻**。
- 涉及用户路径的改动，交付前**从用户座位点一遍**（面板 → app），不以 CI 绿灯当交付证明。
- 每份结论标注证据等级：**实测 / 源码 / 推断**——推断必须显式标出。

---

## 3. 执行顺序

1. P1 收尾：ops `pairlink` + 面板按钮（依赖 bridge，已就绪）。
2. P2 删除（P1 可用后立刻做，避免两套并存）。
3. P3 + P4（面板与 status 统一）。
4. P5 + P6 文档对齐。
5. 全量验收：从零走一遍（粘 URL 装扩展 → 面板加对端 → 装机 → 启动 → 生成链接 → app 打开）。

每步独立可回滚；P2 是唯一的删除型改动，回滚 = `git revert`。

---

## 4. 本轮已获得的证据

| 结论 | 证据 |
|---|---|
| 配对路径可用 | 对端 `client-pairing-sessions.json`：`pair_81fbf3cd… usedAt=14:02:40Z clientId=8eff9db5…` |
| app 用它当服务器 | 控制端 `settings.json`：`desktopHosts[0].clientToken=oc_client_…`，`desktopSshInstances: []` |
| 对端签发独立 token | `remote-clients.json`：`8eff9db5… auth=pairing lastUsed=14:16:57Z revoked=null expires=null` |
| 我们的代码能自持转发并取回链接 | `pairLink()` 实测：自起 `ssh -N -L 127.0.0.1:4610:127.0.0.1:2610`，返回 379 字符链接 |
| 上游 managed 装不了目标机 | 断网实测 `ENOTFOUND ×3` → stale cache → `ETARGET`（`~/.npm/_logs/…debug-0.log`） |
| `uploadBundleOverSsh` 未实现 | 源码仅 2 处引用（sanitizer + UI 模型），无消费方 |

---

## 5. 不做 / 延后

- **不做**：fork openchamber；自建连接 UI；把 SSH 密码存进我们的记录（P1 之后无必要）。
- **延后**：给上游提 `uploadBundleOverSsh` 实现（schema 已有）——若被接受，我们的 provisioning 可
  进一步退化为"只供货"，把安装也交给原生 managed 流程。

## 6. 待你决定（影响投入产出比）

**EL7 / 离线这一档在生产里有多少台？** 一两台 → provisioning + CI 包体系要重算；
一批 → OCRC 定位就是"供货层"，其余全部让给上游。这个答案决定 P1 之后是否还要继续投入。

---

## 阶段 0 实测结论（2026-10-18）

| # | 不确定 | 结论 | 证据等级 |
|---|---|---|---|
| U1 | 桌面 2.4.0 ↔ 对端 2.3.3 能否真干活 | **成立**。经转发打对端 API：`/api/version` 握手 OK（`apiVersion:1` + 兼容字段）、`/api/session` 24KB 真实会话、`/api/fs/list` 10KB 目录、`/api/provider` 在修好中继后返回 `deepseek`/`zhipuai-coding-plan`（`activation: enabled`）。**"发一条消息拿回答"仍未跑通**（留给 D6 正式写） | 实测 |
| U2 | 对端运行期外联 | **确实外联，且经我们中继**：对端 openchamber 取 `models.dev` 模型目录 + `api.openchamber.dev/v1/update/check`，走我们注入的 `HTTP(S)_PROXY=127.0.0.1:2711`。**发现真缺陷**：我们改走配对路径时丢掉了 `-R` 出网腿（日志里 69 次 `ECONNREFUSED 127.0.0.1:2711`、provider 列表空） | 实测 |
| U3 | 实例崩了会不会重拉 | **会**：`startExternalMonitor` 每 tick 查 health，不健康即 `startInstance` 重拉，健康时也补中继（`remote-instance-bridge.ts:430-460`）。**但监护只在 `up()` 后启动** → 已把起点提前到 `pairLink`。实测：杀掉中继 ssh → 30s 内自动恢复 | 实测 |
| U4 | 对端能不能装扩展 | **能**：对端有 git + `~/.ssh/id_ed25519`，且**经我们中继** `git ls-remote https://github.com/BD7PIL/ocrc.git` 成功 → https 源装扩展可行，**不需要推私钥**（D11 的顾虑不成立） | 实测 |
| U5 | 老机器资源 | **充足**：`/home` 59G 可用、内存 13G 可用，我们占 1.2G、`.ocrc-bak` 仅 1 份 → D5 的磁盘检查降级 | 实测 |
| U6 | C 批值不值得做 | 判断问题（机器数量与一致性需求），不列为前提 | — |
| U7 | 上游会不会补离线能力 | 不可预测 → D10 跟踪 | — |
| U8 | 我能验到哪 | 能验 API 层与链接生成；**Electron app 内的点击需用户** | 实测 |

**阶段 0 修掉的两个真缺陷**（提交 `3092b1bd`）：

1. `pairLink` 现在同时确保 `-R` 出网腿。配对路径替掉了桌面壳的实例记录，而那条记录原先承载这条腿；`-L` 与 `-R` 缺一，对端就失去出网 → provider 列表空、模型目录取不到。
2. `pairLink` 现在启动外部监护。**"在跑"不等于"被监护"**：没有监护，中继会随临时拥有者进程一起死。

**验证**：经中继取 `models.dev` 元数据返回 **200（3.6MB）**；`/api/provider` 恢复列出 provider；杀掉中继 ssh 后 **30s 内**由监护自动拉回。

**收敛后的范围变化**：
- **C 批从"价值待定"升为"硬需求"**——U1 证明"管道通但 provider 空/模型目录取不到时不能干活"，而 provider 配置与凭据正是 C 的内容。
- **D5 磁盘检查降级**（U5）。
- **D11 只需文档**（U4），无需另案。
- **D1 的必要性被 U2 证实**：对端每次取模型目录都依赖中继，中继不在就刷错误。
- 新增约束：**中继寿命必须绑常驻拥有者**（service），临时进程持有会在其退出后断掉（D7 一并处理）。
