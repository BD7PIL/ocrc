# 上下文管理三项目对比：opencode dcp vs headroom vs opencode-deep-memory

- **日期**：2026-10-15
- **性质**：三项目深入对比调研。两个外部项目为网络一手调研（GitHub API / raw.githubusercontent / npm registry，非博客转述）；deep-memory 为本地源码盘点（`/home/demo/develop/opencode-plugin/opencode-deep-memory`）。
- **触发**：用户要求「调研 opencode dcp、我们自己开发的 opencode-deepmemory、headroom 这三个项目，深入评估差异和优缺点」。

## 0. 项目判定

| 项目 | 判定 | 元数据 |
|---|---|---|
| **dcp** | [Tarquinen/opencode-dynamic-context-pruning](https://github.com/Tarquinen/opencode-dynamic-context-pruning)，npm `@tarquinen/opencode-dcp` | **DCP = Dynamic Context Pruning**；4,348★ / 257 fork / 78 open issues；v3.2.0（2026-09-20，"OpenCode V2 support"）；AGPL-3.0-or-later；TS；npm 周下载 9,217；2025-11-20 立项。判定依据：GitHub 搜 `opencode dcp` 18 个仓库绝大多数是其 fork/移植，npm 生态 14 个同名包 repository 字段都指向该仓库。来源：[repo API](https://api.github.com/repos/Tarquinen/opencode-dynamic-context-pruning)、[npm downloads](https://api.npmjs.org/downloads/point/last-week/@tarquinen/opencode-dcp) |
| **headroom** | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom)（原 chopratejas/headroom，301 迁移至组织） | 75,379★ / 5,850 fork；v0.41.0（2026-10-14），共 174 个 release（1-2 天一版）；Apache-2.0；Python≥3.10 + Rust crates（maturin 混合构建）；核心作者 Tejas Chopra（1330 commits）；2026-01-07 立项，日级活跃。来源：[repo API](https://api.github.com/repos/headroomlabs-ai/headroom)、[PyPI](https://pypi.org/pypi/headroom-ai/json)、[docs](https://docs.headroomlabs.ai/docs) |
| **deep-memory** | 本机 `/home/demo/develop/opencode-plugin/opencode-deep-memory`，npm `@bd7pil/opencode-deep-memory` v0.14.1 | MIT；2026-06-15 首提交至 2026-08-12 最后提交，87 commits / 38 tags / 36 个 npm 版本；src 6,032 行 / tests 5,748 行（46 文件 450 测试全过）；dist/index.js 591KB；Node≥20 |

## 1. 一句话定位（三者不是直接竞品，是三层堆叠）

- **deep-memory = 跨会话知识层**：回答「跨会话记住什么」。持久记忆 + compaction checkpoint + 上下文重建，OpenCode 原生插件。
- **dcp = 会话内注意力管理**：回答「本会话内什么不用重读」。模型自己决定压什么（调 compress 工具自写摘要），纯会话态、零持久化。
- **headroom = 传输层字节经济学**：回答「哪些字节根本不必原样进模型」。工具输出/JSON/日志/文件进 LLM 前确定性压缩，代理/库/MCP/wrap 四形态，代理无关。

重叠区只有「压缩 + 可逆恢复」一个交点。README 定位原话：dcp "Automatically reduces token usage in OpenCode by managing conversation context"；headroom "Compress tool outputs, logs, files, and RAG chunks before they reach the LLM"；deep-memory "Persistent context intelligence for OpenCode — cross-session memory, compaction checkpoints, context reconstruction"。

## 2. 总对照表

| 维度 | dcp | headroom | deep-memory |
|---|---|---|---|
| 接入形态 | opencode 插件（V1+V2 双代，`lib/v2/` 独立层） | Python 库 / TS SDK / HTTP 代理 / MCP server / `headroom wrap opencode` | opencode 插件（`@opencode-ai/plugin`，7 类 hook） |
| 压缩决策权 | **模型**（compress 工具参数自带 summary，零独立 LLM 调用） | **确定性算法**（字段方差 SmartCrusher / AST CodeCompressor / 内容路由）+ 自有 HF 小模型（Kompress-v2，prose/日志） | **正则启发式**（compaction 抽取）+ **宿主 LLM 子会话**（idle 整理，Mem0 式 ADD/UPDATE/DELETE） |
| 持久化 | 无（会话态即弃；仅调试日志 `~/.config/opencode/logs/dcp/`） | SQLite + HNSW 向量（跨代理共享记忆，附带品；GH #462 防跨项目泄漏） | 纯 Markdown + JSON 状态（MEMORY.md 200 行/25KB 上限 + topics/ + checkpoint.raw.json；文件锁 + mtime 竞态防护） |
| prompt cache | **反面教材**（自认改写消息击穿前缀，按 token 计费可能反而变贵） | 一等公民（live-zone 只压新增字节 + CacheAligner 只标记不改写） | 一等公民（字节稳定冻结注入块 `<deep-memory-stable>` + mtime 缓存） |
| 可逆恢复 | `{...}` block 占位符互引展开 | CCR：原文本地缓存，`headroom_retrieve` 取回 | CCR：SHA-256 哈希 TTL 30min，`deep_expand(hash)` + 长输出落盘双通道 + 主动展开（实体重叠≥0.4 每 turn 还原 ≤2 条） |
| opencode v2 | ✅ v3.2.0 原生（peer `@opencode-ai/plugin >=1.18.29`，devDeps 装 v2） | ✅ 形态无关（代理层，官方兼容表含 opencode + 专文提醒第三方 provider 配置） | ⚠️ **未验证**（devDeps 停在 1.17.6 v1 世代；peer 声称 >=0.1.0 全兼容但无矩阵测试） |
| 中文/CJK | 无专门处理 | 英文中心（Kompress 按英文 agentic traces 训练） | ✅ CJK unigram+bigram 分词的 BM25（对中文工作三家唯一） |
| 检索 | 无（不检索） | 向量（HNSW） | BM25 k1=1.5 b=0.75 + heading 分文档 + 时间衰减 + 实体 boost |
| 成熟度/势头 | 11 个月；**维护放缓，重心移至继任项目 Sleev**（本地代理形态，支持 Claude Code/Codex/OpenCode/Pi/Hermes） | 9 个月 174 release，日级活跃；open-core 企业化（Enterprise/Teams：SSO/VPC/高级压缩器） | 单人 2 个月高强度迭代；**2026-08-12 起停滞两个月** |
| 环境要求 | opencode 插件；运行依赖 `@anthropic-ai/tokenizer` 等，无外部服务 | Python≥3.10 + Rust 组件 + 常驻代理进程（沙箱/air-gap 不友好）；遥测 beacon 默认开 | Node≥20；零运行时依赖（瑕疵：zod v4 被整个打进 dist，5 处 CJS require 是 ESM 宿主隐患） |
| 主要风险 | AGPL 传染；小模型压缩质量不可控；#549 消息 ID 别名 4 位上限（会话超 ~9,999 条不可写） | **纯代码会话收益趋零**（保护门故意 passthrough）；企业版分走高级压缩器；444 open issues | 全 mock 单测（3 个真机 bug 才暴露）；v2 兼容债；BM25 检索天花板 |

## 3. 各自深评

### 3.1 dcp —— 模型自治的优雅实验，但作者自己已经转向了

**机制**（[index.ts](https://raw.githubusercontent.com/Tarquinen/opencode-dynamic-context-pruning/master/index.ts)、[prune.ts](https://raw.githubusercontent.com/Tarquinen/opencode-dynamic-context-pruning/master/lib/messages/prune.ts)、[range.ts](https://raw.githubusercontent.com/Tarquinen/opencode-dynamic-context-pruning/master/lib/compress/range.ts) 一手验证）：挂 `experimental.chat.messages.transform`（核心）+ system transform + `/dcp` TUI 面板 + `/dcp-compress` 命令；唯一工具 `compress`（range/message 两模式），模型在合适时机调用并在参数里自己写摘要——**插件不发独立 LLM API 调用**。修剪管线四遍扫描（压缩区间过滤 → tool 输出 → tool 输入 → tool 错误），占位符替换；确定性策略与模型无关：同工具同参数去重只留最新、错误调用巨型输入限期清除、edit/write/question 输出 + 用户消息 + `<protect>` 标签 + 4 轮 turn 保护；阈值注入（maxContextLimit 100k / minContextLimit 50k，支持百分比和按模型覆盖）+ system prompt nudge 推动（默认每 5 次）。

**优点**：压缩质量判断权交给最懂上下文的模型本身；零外部服务零独立调用成本；确定性管线 + 多层保护扎实；22 个测试文件含 prompt-cache 回归脚本（`test-dcp-cache.sh`）；配置有 JSON Schema（dcp.schema.json）+ 7 个可覆盖 prompt；4.3K★/9.2k 周下载/≥14 个衍生叉包（含 Claude Code 移植 claude-dcp、ZCode 移植 zcode-dcp）的社区验证。

**缺点/限制**（README 自述 + open issues 一手抓取）：
1. **维护放缓（未死）：新工作移至 Sleev（后证实为闭源商业产品，见 §6）**——README 明示；本地代理形态。选型最重要的信号：作者用自己的行动承认了 hook 层的天花板；但 dcp 下载量仍是 Sleev 的 ~20 倍，插件继续维护。
2. **prompt cache 击穿**：视图改写打断缓存前缀，按 token 计费可能反而更贵（README 明示）——插件层做消息改写的结构性死穴。
3. 已知 bug：#549 消息 ID 别名 4 位上限；#632 GPT 系把 `@N@` 压缩引用标签抄进回复（V2）；#608 nudge 文本泄漏到 UI；#393 斜杠命令仅 TUI 生效。
4. 功能缺口：#489 已压缩历史无法重新压缩；#457 `/fork message` 后可能泄漏 pre-fork 消息；#258 不修剪 thinking token。
5. 架构取舍：判断权在模型 → 小模型压缩质量不可控（README 建议小上下文模型调低阈值）；message 模式/子代理处理/自定义 prompt 均 experimental 默认关。
6. AGPL-3.0 传染性——商用集成注意。

### 3.2 headroom —— 传输层压缩的工业级赢家，但对「纯代码会话」几乎无效

**机制**（[README](https://raw.githubusercontent.com/headroomlabs-ai/headroom/main/README.md)、[llms.txt](https://raw.githubusercontent.com/headroomlabs-ai/headroom/main/llms.txt)、[Limitations](https://docs.headroomlabs.ai/docs/limitations) 一手验证）：ContentRouter 按内容类型路由压缩器——SmartCrusher（JSON：字段方差统计保留错误项/离群值/首尾边界，Kneedle 自适应 K）、CodeCompressor（tree-sitter/ast-grep AST 感知，11 语言，保留 imports/签名/类型）、Kompress-v2（自有 HF 模型，prose/日志）、CacheAligner（只标记击穿 KV-cache 的易变内容，从不改写）；live-zone 压缩（只压新增字节，冻结前缀字节一致）；CCR 可逆；四种接入形态（库/HTTP 代理/wrap 16 个 agent/MCP 三工具 `headroom_compress|retrieve|stats`）；附带跨代理共享记忆（SQLite+HNSW）+ `headroom learn` 离线挖掘失败会话写 CLAUDE.local.md；官方基准 SRE 55,957→24,340 tokens（-57%）精度零回归，带可复现命令与 methodology 免责。

**优点**：生态位最稳（75K★、日级 commit、PyPI/npm/Docker 三渠道、文档站完整、Rust 性能核、LangChain/LiteLLM 等 5+ 框架集成）；确定性路线 + cache 一等公民；可逆 CCR + 失败学习 + 跨代理记忆三个差异化功能；基准诚实（自标「单样本方向性测量」）。

**缺点/限制**（官方 Limitations 页自曝 + issues 观察）：
1. **编码代理核心场景被自己的安全门挡住**：`protect_recent_code=4`（最近 4 条消息内的代码 passthrough）+ analyze/review/debug 关键词会话全代码保护 →「纯代码会话收益极小」；CodeCompressor「被安全门故意挡住，大多数字面场景不触发」。
2. RAG 块、grep 结果、system prompt、图片（固定 ~1,600 token 计）一律不压缩。
3. **匿名遥测 beacon 默认开启**（压缩比/模型 ID/OS，不含内容；`HEADROOM_BEACON=off` 关闭）。
4. open-core 分界线就在常用功能边上：tool search、高级压缩器、模型路由在企业版。
5. 444 个开放 issue；高热项多为代理覆盖诉求 + wrap 对 agent 版本变动敏感（wrap claude 报 API Error 的 bug 报告）。
6. 短对话/短负载开销超收益；本地代理进程在沙箱/air-gap 环境跑不了（README "When to skip"）。

### 3.3 opencode-deep-memory —— 三者中唯一的「知识层」，设计密度高但已停摆两个月

**机制**（本地源码盘点）：`@opencode-ai/plugin` 挂 7 类 hook（chat.params / system.transform / messages.transform / session.compacting / event / tool / tool.execute.after）+ 7 个工具（memory_search/store/forget/expand/topic + context_compress + deep_expand）。存储纯 Markdown：项目级 `.deep-memory/`（MEMORY.md 200 行/25KB 硬上限 + 90% 警告溢出归档 + topics/ + checkpoint.md + checkpoint.raw.json + 文件锁）+ 全局级 XDG。三条捕获腿：LLM 调 memory_store；compaction hook 同步截获全量消息 → 5 个中英双语正则抽取器（decision/constraint/gotcha/intent/file-change）写 checkpoint；idle 触发 LLM 子会话整理（增量阈值 + 四道校验 + mtime 竞态防护 + 防自触发级联守卫）。每 turn 确定性降噪（剥旧 reasoning/截断旧 tool error/保护头 3 尾 8 和 user 消息）+ capture-time 限幅（bash 48K/read 50K 等）+ 压力 nudge（≥50K 一次、≥120K 每次）+ 字节稳定注入保 prompt cache + CCR 可逆 + v0.14.0 主动展开（用户消息与 CCR 条目实体重叠 ≥0.4 自动还原）。

**优点**：唯一直击「跨会话知道什么」——compaction 前同步 checkpoint 是另外两家完全没有的时机点；BM25+CJK bigram（对中文工作三家唯一的原生优势）；Markdown 人可读可 git；字节稳定注入；零运行时依赖；MIT。工程纪律显著高于同类业余项目：450 测试（5748 行测试 vs 6032 行源码）、mtime-race/anti-cascade/pending 持久化等真实 bug 的回归测试、PLAN_V5/V6 共 66KB 证据驱动设计文档（V6 的 G1-G11 gap 清单明确引用 DCP/Headroom/Mem0/Cursor/A-Mem 等 14 个项目+论文，负决策也有依据：明确不采纳 Cognee 图数据库/Letta diff/LLMLingua 困惑度压缩）。

**缺点/限制**（README 自曝 + 代码内自证）：
1. v0.14.1（2026-08-12）后**停滞两个月**。
2. 450 测试全 mock client——0.14.1 的三个 bug（scope 默认值、Jaccard 误报、pending 持久化）全是真机跑才暴露；单测与真实行为间有已知缺口。
3. **opencode v2 兼容完全未验证**（devDeps 停在 1.17.6 v1 世代）——而 ocrc 生产栈正在迁往 v2.0.27。
4. 文档引用断裂：多处源码注释引用 DESIGN.md/DESIGN_V4.md，文件不存在。
5. 死代码残留：`formatRepoMap`/`getTopSymbols`（V4 repomap 注入遗留）无调用方。
6. 5 处 CJS `require()` 在纯 ESM 宿主是运行时隐患；zod v4 被整个打进 dist（591KB 主因），与「零依赖」宣传不符（靠宿主传递依赖的运气而非声明）。
7. SimHash 整理方案已实证失败（长文本误报 0.83-0.94，合法条目被拒存），v0.14.1 换 token Jaccard ≥0.9——记忆去重仍是弱点区。
8. README 与实现有出入（宣称 grep/search 分组捕获，实际统一 10K 字符截断）。

## 4. 深挖四维

### 4.1 可逆性设计的趋同演化

三家「压缩后可取回」惊人相似：dcp block 占位符互引 / headroom CCR retrieve / deep-memory CCR deep_expand。不是巧合是谱系——deep-memory 的 PLAN_V6 站在两者肩膀上设计（DCP 教会它「别注入消息 ID」——#573 反馈循环教训；Headroom 教会它 capture-time 限幅）。差异在恢复通道：dcp 靠模型引用占位符、headroom 靠 MCP 工具、deep-memory 靠工具 + 主动实体重叠自动展开——最后这条激进特性三家只有 deep-memory 有（≤2 条/turn、3 秒节流、误报风险曾让它在 PLAN_V6 评审中被两轮降级到 0.14.0）。

### 4.2 prompt cache 态度 = 架构分水岭

headroom 与 deep-memory 把「不改字节稳定前缀」当设计约束（live-zone / 冻结注入块）；dcp 的整个机制（视图改写）注定与 cache 对抗——这大概是作者转向 Sleev 代理层的深层原因：代理层能在请求发出前做字节级手术而不碰会话历史。**行业收敛信号明确：两个外部项目殊途同归到「代理/传输层」——插件 hook 做压缩有结构性天花板（cache 击穿、agent 耦合、版本追赶）。** 这是对 deep-memory 路线最重要的外部证据。

### 4.3 共存性

- **dcp + deep-memory 会打架**：两者都挂 `experimental.chat.messages.transform` 和 system transform——一个按模型指令换占位符、一个每 turn 确定性降噪 + 阈值 nudge，双重改写同一消息数组的顺序与叠加效果未定义。
- **headroom 与两者天然正交**（传输层 vs 插件层），可组合，但「字节压缩叠 token 压缩」的边际收益需实测。

### 4.4 对本机拓扑（EL7 被控 + Win/Mac 面板 + ocrc）的适配

| 项目 | 落地点 | 障碍 |
|---|---|---|
| dcp | 直接装 v2 被控端（v3.2.0 已支持） | AGPL（个人使用无碍）；维护放缓；与 ocrc 同装时 hook 叠加未测 |
| headroom | 面板宿主（Win/Mac）跑代理，塞进 ocrc 已有 **form-B air-gap 模式**（`ssh -R` 反向推 HTTPS_PROXY 给被控 opencode）——与三项目唯一现成咬合点 | 代理本体跑不了 EL7（Python≥3.10 vs EL7 glibc/Python 3.6）；遥测 beacon 需显式关；企业版功能边界 |
| deep-memory | 战略资产（唯一知识层 + CJK） | **v2 兼容移植是前置关**；单测盲区需真机 E2E 补 |

## 5. 战略结论（初版；§6 Sleev 增补后有修订，见 §6.2）

1. **别把三者当竞品选型——它们是三层**：headroom（字节层，已被工业界商品化，Apache 免费拿用）⊃ dcp（会话注意力层，官方建议新装用 Sleev，但插件继续可用、仍是唯一可审计的开源插件选项）⊃ deep-memory（知识层，仍是空旷地带）。
2. **token 经济学已经被 headroom 用 Apache-2.0 免费解决**，deep-memory 不该追赶压缩特性；其护城河在：CJK、Markdown 透明性、compaction checkpoint、零基建 MIT——这四点 dcp/headroom 都给不了。
3. **若复活 deep-memory，优先级**：v2 兼容移植（dcp 的 `lib/v2/` 是现成地图）> 真机 E2E 补 mock 盲区 > 记忆质量（去重/检索）——而不是任何压缩特性。
4. **对 ocrc 生产 v2 引擎，今天能落地的**是 dcp（已支持 v2）或 headroom（form-B 代理位）；deep-memory 需先补 v2 移植。

## 6. 增补：Sleev 深调研（2026-10-15 同日补）

> 初版只引了 dcp README 一句 "most new work moved to Sleev" 就下了「行业收敛到代理层」的判断，没查 Sleev 本体。补查后该判断**被加强**，但开源选型格局**被改写**。

### 6.1 核心事实（全部一手：npm registry / sleev.ai 官方文档 / GitHub API / dcp README 原文）

| 项 | 事实 | 证据 |
|---|---|---|
| 本体 | **Sleev Labs Inc.（美国公司）的商业闭源产品**——本地 Rust 网关 daemon，默认 `127.0.0.1:17321`，OpenAI/Anthropic/Gemini 兼容透传 + 每请求上下文重写 | https://registry.npmjs.org/sleev/latest （`repository` 指向 `github.com/sleev-labs/sleev` 但**该仓库私有，匿名 404**）；https://sleev.ai/docs/config/gateway-bind |
| license | **专有 EULA**（npm README 原话 "proprietary software owned by Sleev Labs Inc."，"does not grant open-source rights"），**不继承 dcp 的 AGPL**；无法自审网关对 prompt 做了什么，隐私依赖官方声明（"does not send your conversation history, prompts, code… to our servers"） | https://registry.npmjs.org/sleev （readme Legal 节）；https://sleev.ai/eula ；https://sleev.ai/docs/faq |
| 作者链 | npm maintainer `sleeve-org`（dansmolsky@gmail.com）= dcp 提交署名 Daniel Smolsky = dcp ko-fi 收款人——身份强吻合（在公司内的确切职务无公开页面） | https://registry.npmjs.org/sleev/latest ；dcp commits API |
| 节奏 | v1.8.10（2026-10-14）；~110 个版本几乎周更（2026-05 起真实发布）；**配额制**：无账号 500 次/月、免费账号 2,000 次/月、Starter $5/1 万次、Pro $20 无限（仅命中 premium 模型名单且实际省了 token 的请求计数，超额后请求直连不再优化） | https://registry.npmjs.org/sleev （time 字段）；https://sleev.ai/pricing ；https://sleev.ai/docs/premium-requests |
| 下载量 | 近 30 天 **2,720**（dcp 同期 53,177——**dcp 仍是主流，约为 Sleev 的 20 倍**） | https://api.npmjs.org/downloads/point/last-month/sleev ；https://api.npmjs.org/downloads/point/last-month/@tarquinen/opencode-dcp |
| dcp 现状 | **未死未归档**：最后 commit 2026-09-25，release v3.2.0（2026-09-20），节奏放缓、近期 tag 均 beta。README Project Status 原文："DCP remains available for OpenCode plugin users, but new features are landing in Sleev first. If you are starting fresh, we recommend trying Sleev" | dcp README；https://api.github.com/repos/Tarquinen/opencode-dynamic-context-pruning/releases |
| 概念继承 | dcp 的 compress 工具被收归网关后台决策——"optimizes session context when the expected savings outweigh provider-cache update costs"；**网关自己有压缩 LLM 调用**（"Sleev's costs include the gateway's own compression calls"，用哪个模型/供应商未披露）；阈值 nudge / 保护规则 / 占位符机制无公开对应（闭源不可验证） | https://sleev.ai/ ；https://sleev.ai/performance （footnote 原文） |
| opencode 支持 | **v1 和 v2（beta）双支持**：改 provider baseURL + `sleev-provider`/`sleev-harness` headers（或 URL 路由前缀 `/sleev/<harness>/<provider>`）；opencode 1 需 `compaction.prune:false` 把上下文管理让给 Sleev；provider 矩阵所有 harness 中最广（anthropic/openai/codex/copilot/google/moonshotai/kimi/zai/zen/opencode-go 等；anthropic 仅 API key，不支持 Claude Max 订阅） | https://sleev.ai/docs/harness-setup/opencode ；https://sleev.ai/docs/config/providers |
| 跨会话记忆 | **没有**（全量文档 grep 无 memory/cross-session/persist；自称管理 "transient session state"；"Context optimization, caching, and session history stay strictly on your device"） | https://sleev.ai/llms-full.txt ；https://sleev.ai/docs/what-is-sleev |
| 自报基准 | DeepSWE 1.1、113 任务：input tokens 18.57M→3.49M（**-81%**）、成本 $18.08→$3.99/任务、solve rate 持平（61.1%→61.9%）；对比组含 Headroom（$120.22/会话）。厂商自研基准（官方自注 "not comparable to official leaderboard scores"）；EULA 第 6 条允许善意独立基准测试但要求公开方法论；复现仓库 https://github.com/sleev-labs/benchmark （1★，唯一公开代码） | https://sleev.ai/performance ；https://sleev.ai/eula |
| 可审计性 | 主仓库私有、无公开 issues/测试/roadmap——**不可审计** | https://api.github.com/repos/sleev-labs/sleev → 404 |

### 6.2 修订后的结论（覆盖 §5 中被改写的两条）

1. **「行业收敛到代理/传输层」信号加强**：dcp 作者不只是把新工作挪去代理形态——是**成立公司、做了闭源商业产品**。插件 hook 层的天花板现在有两条独立证据（dcp→Sleev、headroom 的 wrap 生态）且带商业级背书。
2. **但压缩层开源选型格局改写**：代理层开源选项只剩 **headroom（Apache-2.0）**；Sleev 闭源 + 配额计费 + 不可自审，对 air-gap / 自审 / 成本可控三类场景全部减分——**仅作商业替代项记录，不作推荐**。dcp 没有死：仍是唯一可审计、可自改的 opencode 插件选项，下载量是 Sleev 的 ~20 倍；初版「hook 形态已被作者自己放弃」表述过重，修正为「官方建议新装用 Sleev，插件继续可用、新功能 Sleev 优先」。
3. **跨会话记忆四项目全空白**：Sleev 加入后确认——dcp/headroom/Sleev 三家都不做持久知识层。deep-memory 的生态位比初版判断更空旷、更独特。
4. **对 ocrc 拓扑**：Sleev 理论上也能塞 form-B `ssh -R` 代理位（网关跑面板宿主），但闭源 + 计费 + 流量不可自审与 ocrc 的 air-gap/隐私定位相性差；headroom（Apache、本地、遥测可关）保持 form-B 首选，dcp 保持被控端插件首选。**E5→D2→D3 行动计划不受影响**（Sleev 只改选型表述，不改行动顺序）。

### 6.3 证据边界（不做推测的部分）

`sleev-labs/sleev` 私有 → star 数 / open issues / 测试覆盖 / 源码级机制（dcp 的占位符与嵌套摘要是否保留、Guidance 注入的具体实现）均不可验证；内部压缩调用用哪个模型或供应商、是否需要额外 API key 未披露；Tarquinen（Daniel Smolsky）在 Sleev Labs 的确切职务无公开确认；HN/X 上无社区讨论帖（hn.algolia.com 搜索为空）。
