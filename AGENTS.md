# ocrc — 面向 AI 代理的导读

- **产品定义与边界**：[docs/PRODUCT.md](docs/PRODUCT.md) —— 新需求先过这里（分层归属判据 + 明确不做清单）。
- **架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（以代码为准，v0.26.5+ 持续同步）。
- **运维**：[docs/OPS.md](docs/OPS.md)。
- **开发**：`npm install && npm run build:all` · `npm test`（后端 vitest）· `cd web && npm test` · `npm run typecheck` · `bash scripts/spike-restart.sh`（隔离 dev 实例，绝不碰生产）。
- **兼容硬边界**：被控端 opencode pin 1.18.x；EL7/glibc 2.17 是遗留生产下限。
- 历史遗留的 pact/pactify 多代理协作协议已于 2026-10-05 移除（工具从未存在于本机，属上游遗留死配置）。
