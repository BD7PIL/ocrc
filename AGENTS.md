# OCRC — 面向 AI 代理的导读

**一句话**：这个仓库只做一件事——**把一整套 openchamber 装到远程 Linux 机器上，起它，配对进桌面 app，并保持它的配置与凭据同步**。别的都不要了（见下"已删除"）。

- **命名**：品牌 **OCRC**，机器标识一律 **`ocrc`**——CLI 命令 `ocrc`、npm 包 `@bd7pil/ocrc`、扩展目录 `extensions/ocrc`、`panel.id = ocrc`、发布资产 `ocrc.zip`、tag `ocrc-<ver>` / `ocrc-latest`、镜像分支 `ocrc`。**不再有 `-remote` / `ext-` 这类限定词**。扩展 `panel.id` 变更过 → **旧安装（id `ocrc-remote`）要卸载重装**。`ocrc-omo-view` 扩展已删除（2026-10-29：omo 引擎侧退役后数据源已死）→ **旧安装要卸载**。
- **工件命名**：平铺目录寻址的带版本（`ocrc-openchamber-pack-<ver>-linux-x64-<tier>.tar.gz`，因为 `OCRC_PACK_DIR` 是平铺镜像目录）；tag 寻址的靠 tag（`ocrc.zip`，`ocrc-<ver>` 钉 / `ocrc-latest` 通道）。扩展**粘 URL 安装**：git 装法（`https://github.com/BD7PIL/ocrc#ocrc`）能自更新，zip 装法不能。发布走 `.github/workflows/ocrc-extension.yml`（仅手动 dispatch）。

## 仓库里有什么

| 位置 | 是什么 |
| --- | --- |
| `extensions/ocrc/` | **面板扩展**：`panel/`（服务器列表）、`status/`（右侧只读读数）、`service/`（宿主上那个能跑 ssh 的进程，两条路由 `/health` + `/remote-instance`）。产物提交进仓库（零构建 folder 安装）。 |
| `src/core/` | 实例线核心：`remote-instance*`（arg 构造 / 门禁 / 桥接 / 推送 / 出网代理）、`remote-instances`（store）、`remote-instance-bootstrap`（一条命令的步骤序列）、`instance-config` + `config-merge`（配置同步）、`components`（通用组件装配：读 `provision.json`、装插件/工件/扩展）、`forward-ownership`（转发持有者标记）、`ssh-askpass`、`bin-cache`（工件缓存）。 |
| `ops/components.json` | 组件版本 pin（reeve / opencode-deep-memory）。`ocrc remote apply --with-components` 用它；`OCRC_<NAME>_PIN` 可覆盖。 |
| `src/cli/remote.ts` | `ocrc remote add\|plan\|apply\|up\|down\|pairlink\|config-diff\|sync-config\|sync-auth\|peerlog\|upgrade\|prepare\|bootstrap\|offline-proof` —— 面板的 headless 等价物。`bootstrap` 只是把前七步按顺序串起来，不新增底层能力。 |
| `ops/` | 引擎 pin manifest（`ocrc-follow.yml` 跟着上游写，`bin-cache` 读）。 |
| `scripts/` | `accept-remote-instance.sh`（真机端到端验收）、`preflight.mjs`（提交前自检）、`check-guest-bundles.mjs`、`build-app-pack.mjs`、EL7 node-pty 重建脚本。 |
| `docs/` | [PRODUCT](docs/PRODUCT.md)（边界，新需求先过）· [ARCHITECTURE](docs/ARCHITECTURE.md) · [OPS](docs/OPS.md) · `decisions/`（裁决）· `handoff/` 与 `research/`（历史记录，多数已加"已过时"banner）。 |

## 开发

```bash
npm install && npm run build          # CLI（tsc）
npm test                              # 248 项（实例线）
npm run test:coverage && npm run check:coverage   # 覆盖率硬门槛（基线 scripts/coverage-baseline.json，只升不降）
npm run typecheck && npm run typecheck:tests
npm run preflight                     # 提交前必跑：重建两扩展 + 三处 typecheck + 三套测试 + 覆盖率门槛 + guest 不变量
npm --prefix extensions/ocrc test     # 扩展测试（46 项）
node extensions/ocrc/scripts/preview.mjs   # 真面板挂假宿主，?scenario= 切状态
node extensions/ocrc/scripts/audit.mjs     # 逐组件截图（24 项清单见 preview/audit/README.md）
bash scripts/accept-remote-instance.sh --target user@host   # 真机验收（含真发消息）
```

**改面板/状态区之后**：跑 `audit.mjs` 并**逐张看过**再交（清单与结论表在 `preview/audit/README.md`）。
**改了 `extensions/*/src/` 之后**：必须重建产物（`npm run preflight` 会做），否则 CI 的 dist 一致性会红——这条栽过两次。

## 已删除（2026-10-19，别按旧记忆找）

ocrc 自己的"驾驶舱"那一代**整个从这个仓库删掉了**，它会作为**独立的 openchamber 扩展**在别的项目里做：

- 通道：Telegram（35 命令）、Web PWA/HTTP-WS API、Lark/Feishu、DingTalk、WeCom 推送，以及 `src/connectivity/`（配对/CF Access/cloudflared 暴露）。
- 引擎侧功能：动态工作流（`ocrc wf` + `vendored zcode-dwf`）、日程、技能管理、子代理、goal、会话分享、off-peak、浏览器控制、MCP/上下文/todo/vcs 面。
- 引擎级远程主机：`/api/remotes/*` + 四个 `ocrc_remote_*` agent 工具 + `remotes.json`（**被实例级取代**；两者的区别是"引擎跑在远端"还是"整套 openchamber 跑在远端"）。
- CLI 的 `init/install/uninstall/start/stop/restart/status/restore/pair/host/wf/mcp-browser`、`src/plugin/`（opencode 插件入口）、`src/transport/`（14,914 行）、`vendor/zcode-dwf/`、`desktop/`、`web/`（前端）。
- 18 个运行时依赖随之清零——剩下的代码只用 Node 内建模块。

历史记录在 `docs/handoff/`、`docs/research/`、`docs/decisions/` 与 `CHANGELOG.md`（不回改，多数已 banner）。
