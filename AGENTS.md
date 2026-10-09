# ocrc — 面向 AI 代理的导读

- **产品定义与边界**：[docs/PRODUCT.md](docs/PRODUCT.md) —— 新需求先过这里（分层归属判据 + 明确不做清单）。
- **架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（以代码为准，v0.27 重建蓝图）；web 面板 = `web-next/`（React，1.0-rc）。**rc.3 起 `/` 就是 ZCode 壳**（`/z/*`、`/next/z` 为书签别名，同一组件）；rc.2 旧控制台（Home/Session/Automations/Settings/TokenGallery + 命令面板等浮层）已退役——柿橙配色封存在 `web-next/src/styles/persimmon-theme.css`（不参与构建，回肤取用）。
- **运维**：[docs/OPS.md](docs/OPS.md)。
- **开发**：`npm install && npm run build:all` · `npm test`（后端 vitest）· `cd web-next && npm test` · `npm run typecheck`。
  - **隔离 dev 实例（4199）**：`HOME=/tmp/ocrc-z-home OCRC_HOME=/tmp/ocrc-z-home/.ocrc OCRC_BACKENDS=opencode OCRC_SERVER_URL=http://127.0.0.1:4298 OCRC_SERVER_PORT=4298 OCRC_WEB_PORT=4199 OCRC_OFFPEAK_WINDOW=00:00-23:59 node dist/cli/index.js host`（nohup 后台；**OCRC_BACKENDS/OCRC_SERVER_URL 不能省**，漏了会落回 acp:kimi 后端、/api/sessions 恒空）。
  - `scripts/spike-restart.sh` 是 **4598 遗留脚本**（旧布局），不是本机隔离实例的 runbook——误跑会用同一 TG token 拉起竞争实例、把 4199 host 顶死（Telegram 409 自杀）。生产重启只有 `~/bin/restart-ocrc.sh`（见 OPS.md）。
- **兼容硬边界**：被控端 opencode pin 1.18.x；EL7/glibc 2.17 是遗留生产下限。
- 历史遗留的 pact/pactify 多代理协作协议已于 2026-10-05 移除（工具从未存在于本机，属上游遗留死配置）。
- **N 系列分层规则（2026-10-07 grill 裁决）**：`/z/`（`/next/z`）= vendor 的 ZCode 真前端（上游 **zai-org/ZCode** v3.14.3，Apache-2.0）。两层契约：**ocrc 卡片流（card/sdelta/seq/replayEnd）= 唯一长期稳定核心**——引擎适配、功能扩展都对着它写；**ZCode 界面 + `src/zcode-services/` 翻译层 = 预期频繁变动的表层**——必须保持薄。vendor 修改 = 加法优先 + `web-next/vendor/PATCHES.md` 登记制；验收 = `web-next/vendor/CHECKLIST.md` 逐组件核对。多 agent 适配走引擎层（HarnessAdapter），ACP 列 N4+。opencode 2.x 断裂只体现在 HarnessAdapter。
