# P0-1 实测：插件工具注册语义（多 workspace / 重复注册）

> 计划：[workflow 全量落地](../.zcode/plans/) P0 的第一步。P3 的工具面（模型原生调
> `CreateWorkflow` 等）整个压在「官方 `tool` 钩子注册的工具，在 host 拉起的
> `opencode serve` 里真的可调用」这个前提上，所以先把它证掉。
>
> 环境：**一次性 scratch**（`/tmp/ocrc-p0`，自己的 HOME + 自己的 `opencode serve`，
> 端口 4297）。**生产引擎（用户 :4096，pid 5589）与生产 ocrc 全程零接触**——脚本只 kill
> 自己拉起的 pid（`$!` 与端口占用者双解析：bun 编译的二进制会自我 re-exec，`$!` 不是
> 监听进程）。
> 复现：`bash scripts/spikes/p0-tool-registration/run.sh --with-duplicate`
> 被测引擎：opencode `1.18.32`（`~/.local/bin/opencode`，bun 单文件 ELF）。

## 结论

| 问题 | 结论 |
|---|---|
| 官方 `tool` 钩子注册的工具，在 `opencode serve` 拓扑里能出现吗 | **能**。`/experimental/tool/ids` 里出现探针工具 `wf_echo`，与内建工具同列 |
| 同一进程多个 workspace 各加载一次插件 → 工具怎么算 | **每个 app instance（workspace）各有一份自己的 ToolRegistry**；插件**按「插件文件 × app instance」各加载一次**（实测 2 目录 × 2 插件 = 4 次加载） |
| 同一 instance 内重名工具 | **并存**：`ids` 里同名出现两次，**不报错、不去重、日志无告警** |
| 重名工具模型看到哪个 | **后者静默覆盖前者**：模型面按 id 建普通对象（`o[k.id] = …`），重复键 = last-write-wins，且无任何提示 |
| 插件会自己开端口吗 | **不会**。`ss -ltnp` 里该进程只有 serve 自己的 API 端口 |

一句话：**列表层面并存，模型面 last-wins 静默覆盖。**

## 代码证据（1.18.32 二进制内嵌源码）

1. **自定义工具的合并**（`ToolRegistry.state`）——两条来源都往同一个**普通数组**里 `push`，
   全程没有重名检查、没有 map 去重：

   ```js
   let A=(yield*o.directories()).flatMap((io)=>_t.scanSync("{tool,tools}/*.{js,ts}",{cwd:io,absolute:!0,dot:!0,symlink:!0}));
   if(A.length)yield*o.waitForDependencies();
   for(let io of A){ let ho=It.basename(io,It.extname(io)), jo=yield*s.promise(()=>import(Un(io).href));
     for(let[Xo,Gr]of Object.entries(jo)){ if(!Nn(Gr))continue;
       Q.push(Y(Xo==="default"?ho:`${ho}_${Xo}`,Gr)) } }
   let F=yield*e.list();                                  // ← 插件列表
   for(let io of F) for(let[ho,jo]of Object.entries(io.tool??{})) Q.push(Y(ho,jo));
   ```

   ```js
   W=s.fn("ToolRegistry.all")(function*(){ let D=yield*J.get(G); return[...D.builtin,...D.custom] }),
   I=s.fn("ToolRegistry.ids")(function*(){ return(yield*W()).map((D)=>D.id) }),
   ```

2. **模型面的装配**（prompt 构建处）——数组按 id 收进对象，重复键覆盖：

   ```js
   for(let k of yield*r.tools({modelID:kl.ID.make(e.model.api.id),providerID:e.model.providerID,agent:e.agent,permission:e.session.permission})){
     let W=ue.schema(e.model,Ga.fromTool(k));
     o[k.id]=so({description:k.description,inputSchema:De(W),execute(b,w){ … }})
   }
   ```

3. **插件发现**（`config-plugin` effect，逐 app instance 跑一次）——配置文档的
   `plugins: [...]` 逐条 + 每个配置目录 glob `{plugin,plugins}/*.{ts,js}`（排序后加载）：

   ```js
   if(l.type==="directory"){ let d=yield*i.glob("{plugin,plugins}/*.{ts,js}",{cwd:l.path,absolute:!0,include:"file",dot:!0,symlink:!0}).pipe(n.orElseSucceed(()=>[]));
     d.sort(); for(let s of d)c.push({package:s}) }
   ```

   去重只按 **spec**（`sJ`：同一路径/包名写两次会合并）；**不同插件用同一个工具名不会合并**。

4. **插件默认导出校验**（`rQ`）——`must default export an object with server()`，与
   `src/plugin/entry.ts` 注释里记的形状一致（我们的双导出 `{id, server, setup}` 合法）。

5. **命名规则**（重要）：文件式 `tool/` 目录里的工具会被**自动加前缀**（`default` →
   文件名，具名导出 → `文件名_导出名`）；**插件返回的 `tool` 表用裸名**。

## 实测输出（摘录）

```
== [1] tool ids, workspace 1 (/tmp/ocrc-p0/proj)
["invalid","question","bash",…,"apply_patch","wf_echo","wf_echo"]
== [2] tool ids, workspace 2 (/tmp/ocrc-p0/proj2) — same process, second app instance
["invalid","question","bash",…,"apply_patch","wf_echo","wf_echo"]
== [3] tool list with descriptions（重名只在这里能分辨）
    wf_echo | P0-1 probe echo tool (probe B, DUPLICATE name)
    wf_echo | P0-1 probe echo tool (probe A)
== [4] plugin load events（2 插件 × 2 app instance = 4 次）
{"pid":97693,"cwd":"/tmp/ocrc-p0/proj","msg":"probe2-init"}
{"pid":97693,"cwd":"/tmp/ocrc-p0/proj","msg":"probe-init"}
{"pid":97693,"cwd":"/tmp/ocrc-p0/proj","msg":"probe2-init"}
{"pid":97693,"cwd":"/tmp/ocrc-p0/proj","msg":"probe-init"}
== [5] app-instance bootstraps
   "creating instance" directory=/tmp/ocrc-p0/proj
   "creating instance" directory=/tmp/ocrc-p0/proj2
== [6] sockets owned by the serve process
   LISTEN 127.0.0.1:4297  users:(("opencode",pid=97693,fd=17))
```

`[4]` 里两次 `plugin-init` 的 `cwd` 都是**进程 cwd**（serve 的启动目录），不是被请求的
`directory`——所以插件**不能靠 `process.cwd()` 判断自己在服务哪个 workspace**，要认
workspace 只能走 ctx（V1 `ctx.directory` / V2 `ctx.directory`）。

## 对 P0-3 / P3 的强制约束（本条的「应对」）

1. **工具实现必须幂等且无实例本地状态。** 重名 last-wins 意味着「谁的实现胜出」不由我们
   决定；胜出的那个必须和另一个**行为完全一致**。做法：ATTACHED 工具 = 薄 HTTP 客户端，
   **runId 由 host 分配**（`POST /api/workflow` 返回），工具侧不留计数器/缓存/会话表。
2. **工具名固定、不带实例身份**（不写 `CreateWorkflow-<pid>` 这类后缀）——vendor
   `ui/src/lib/workflowToolNames.ts` 是**按名判定**的，名字必须与上游逐字一致
   （`CreateWorkflow` / `AmendWorkflow` / …）。
3. **工具走「插件」路径，不走 `tool/` 目录。** 插件工具是裸名，正好是 vendor 期望的名字；
   `tool/` 目录会被自动加文件名前缀，直接对不上。
4. **N 个 workspace = N 个 ATTACHED 实例 = N 次注册**，每个实例各自 `tryBecomePrimary()`
   都会读到 `role=host` → 全部 ATTACHED。这是 P0-2（锁文件加角色）/P0-3（ATTACHED 分支）的
   形状依据。
5. **ATTACHED 分支必须零副作用**：不建 transport、不写 state、不起定时器、不选举。
   重复安装（global 目录 + 项目目录各一份）只会得到两份工具而不出错，但**副作用会翻倍**。
6. **今天不能直接装**：PASSIVE 分支（`src/plugin/entry.ts:123-132`）返回的 inert hooks
   **不含 `tool`**，且 PASSIVE 只在「别人持有锁」时进入——而 host **从不取锁**
   （`tryBecomePrimary` 只在 `entry.ts` 出现）。所以此刻把插件装进配置，插件会成为
   PRIMARY 并**自己再拉一套 4099 + TG**（与 host 双冲突）。这就是 P0-2/P0-3 要修的东西。

## 与计划门禁的对应

P0 门禁里的「引擎里出现探针工具 `wf_echo`」已在本次 scratch 实测中达成（`[1]`/`[3]`）；
「插件没监听端口」达成（`[6]`）。剩下两项属 P0-3/P0-4：「能取回值」（真正被模型调用一次，
需要 scratch 里配一个 provider）与「host 不在时逐字回归」。
