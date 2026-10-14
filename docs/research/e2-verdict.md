# E2 spike 裁决：opencode v2.0.27 工具注册路径

- 日期：2026-10-14/15（批次 3 前置实验）
- 环境：`/tmp/e2-lab` 隔离栈（HOME=`/tmp/e2-lab/home`，引擎 :4398，stub LLM :4310，项目 `/tmp/e2-lab/proj`）。零生产流量，零生产引擎触碰。

## 结论（置信度：高，全部一手黑盒实测）

**选路径 1：v2 promise 插件 `setup(context.tool.transform)` 运行时注册**。路径 2（MCP over HTTP）保留为官方配置面 fallback，不再需要为四工具搭 HTTP 服务。

### 决定性证据

1. **`context.tool` 存在但 SDK 类型缺失**：`@opencode-ai/plugin` 2.0.18 的 `v2/promise/context.d.ts` 只列 agent/aisdk/catalog/command/integration/plugin/reference/skill 九个域；引擎运行时实际传入 `tool`（外加 event/experimental/generate/mcp/permission/rpc/storage/vcs/websearch/worktree/session/shell 共 24 个域）。计划前提「setup 无工具注册面」是 **SDK 类型层的假象，不是引擎事实**。
2. **端到端调用打通**：插件 `tool.transform(o => o.add({...}))` 注册 `hello_e2` → stub LLM 收到的 OpenAI tools 数组含 `ocrc_hello_e2` → stub 发 tool_call → 引擎执行插件 `execute` → 会话消息出现 `status:"completed"` 的 tool part，`state.content[0].text === "hello e2 from v2 tool.transform.add"`。
3. **`tool.transform` 面完整**：`{list, get, namespace, add, update, remove}`。`update("grep", t => t.description = ...)` 实测改写 LLM 收到的描述（E2-MARKER 实验），说明 transform 在 LLM 面装配前生效、时序正确。

### add() 的形状契约（踩坑全记录）

| 字段 | 必须 | 实测行为 |
|---|---|---|
| `name` | ✅ | 缺失时 `add` 抛 `e.name.replace`（引擎规范化用） |
| `description` | ✅ | 直通 LLM |
| `options.namespace` | **✅ 关键** | **不带 namespace 的自定义工具进 registry（`list()` 可见，21 个）但不进 agent 的 LLM 面（恒 12 个）**。`namespace:"opencode"` → 工具名变 `opencode_hello_e2` 出现；`namespace:"ocrc"` → `ocrc_hello_e2`。**自定义 namespace 值合法** |
| `options.codemode` | 建议 false | 官方 MCP 资源工具用 true；语义未深究 |
| `args` | 建议 | JSON-schema 形状 `{name:{type:"string",...}}`；stub 传参被正确投递到 execute |
| `output` | 建议 | `{output:{type:"string"}}`；缺省时 execute 返回 `{output}` 报 "Tool result declared output without an output schema" |
| `execute` | ✅ | **必须返回对象**（裸字符串报 `s is not an Object`）；成功形状 `{output: string}`，结果落 `state.content[].text`，status `completed` |

**B1 采用形状**（已在 e2-lab 验证）：

```js
export default {
  id: "ocrc-remote-tools",
  async setup(context) {
    await context.tool.transform((o) => {
      o.add({
        name: "remote_list",
        description: "...",
        options: { namespace: "ocrc", codemode: false },
        args: { /* JSON schema */ },
        output: { output: { type: "string" } },
        execute: async (args) => ({ output: "..." }),
      })
    })
  },
}
```

### 插件加载契约（v2 与 v1 差异，批次 1 文档需修订处）

- v2 只认 **default export**：named export（`export const X = ...`）报 `Plugin must export a default definition with an id and an effect or setup function`。v1 的 `export const X = async () => hooks` 形状在 v2 **不加载**（静默 WARN，不炸引擎）。
- 配置里的本地路径插件必须指向**目录**（含 package.json）；指到 .js 文件 WARN `configured plugin path must be a directory` 后跳过。
- 插件加载是 lazy 的：serve 启动后首次访问 location services（如 GET /api/config）才实例化。
- ocrc 主插件（PRIMARY，v1 `server` 导出 + v2 `setup` 双导出）在 v2 下**从未以 v1 形状加载过**——1.18 时代 hooks.tool 的证据不能平移。E2 后确认：v2 下 ocrc 的四工具走 default-export setup 域。

### 路径 2（MCP）fallback 验证

- `PUT /api/experimental/mcp/{server}?directory=...` body `{"config":{"type":"local","command":[...]}}` → 204；`GET /api/mcp` 可见状态（`failed` 因探针用 /bin/false，端点本身工作正常）。`remote` 型支持 `url+headers`（可带 bearer），对接 Hono :4099 无协议障碍。
- 保留价值：若未来工具需要**跨引擎版本**（v2 之外的第三方 agent）或动态启停，MCP 面是版本无关的。四工具不付这个复杂度。

### 鉴权与实验栈操作备忘

- v2 serve 的 HTTP 鉴权是 **Basic**（`opencode:<password>`），不是 Bearer；password 打印在 serve.log 首行。
- 启动模板：`start-engine.sh` 必须 `export HOME=<隔离 home>` 且 `cd <proj 目录>`（否则 location 落到调用方 cwd）。
- 引擎对 config/tools 的 allowlist 键（`tools:{hello_e2:true}`）对 transform.add 的工具**无效**——可见性由 namespace 决定，不由该键决定。

## 对批次 3 的影响

- B1 注册层 = ocrc 主插件 default export 的 `setup` 里 `context.tool.transform` 批量 add 四个 `ocrc_remote_*` 工具；每工具 `output:{output:{type:"string"}}`、execute 返回 `{output}`。
- B1 工具名：`ocrc_remote_list` / `ocrc_remote_sync_workspace` / `ocrc_remote_provision` / `ocrc_remote_create_session`。
- 测试断言：e2-lab 模式下 stub LLM 面可见 `ocrc_*` 四名；tool part `completed` 语义复用本实验。
- 风险收敛：SDK 未来把 `tool` 域写进类型（现在缺）只会让 TS 用户更顺，不影响运行时契约；但 upstream 可能在某版收窄 namespace 行为——批次 3 集成测试锁定 2.0.27 行为并在 CI 跟随里加注册面 smoke。
