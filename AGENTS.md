# ocrc — 面向 AI 代理的导读

- **产品定义与边界**：[docs/PRODUCT.md](docs/PRODUCT.md) —— 新需求先过这里（分层归属判据 + 明确不做清单）。
- **架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（以代码为准，v0.27 重建蓝图）；web 面板 = `web-next/`（React，1.0-rc）。
- **运维**：[docs/OPS.md](docs/OPS.md)。
- **开发**：`npm install && npm run build:all` · `npm test`（后端 vitest）· `cd web-next && npm test` · `npm run typecheck` · `bash scripts/spike-restart.sh`（隔离 dev 实例，绝不碰生产）。
- **兼容硬边界**：被控端 opencode pin 1.18.x；EL7/glibc 2.17 是遗留生产下限。
- 历史遗留的 pact/pactify 多代理协作协议已于 2026-10-05 移除（工具从未存在于本机，属上游遗留死配置）。
- **N 系列分层规则（2026-10-07 grill 裁决）**：`/z/`（`/next/z`）= vendor 的 ZCode 真前端（上游 **zai-org/ZCode** v3.14.3，Apache-2.0）。两层契约：**ocrc 卡片流（card/sdelta/seq/replayEnd）= 唯一长期稳定核心**——引擎适配、功能扩展都对着它写；**ZCode 界面 + `src/zcode-services/` 翻译层 = 预期频繁变动的表层**——必须保持薄。vendor 修改 = 加法优先 + `web-next/vendor/PATCHES.md` 登记制；验收 = `web-next/vendor/CHECKLIST.md` 逐组件核对。多 agent 适配走引擎层（HarnessAdapter），ACP 列 N4+。opencode 2.x 断裂只体现在 HarnessAdapter。
