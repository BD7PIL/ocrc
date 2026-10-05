// desktop/README.md — ocrc Desktop 薄壳（路线图 ⑥ scaffold）。
//
# 形态（PRODUCT.md 第三条）

窗口 + 托盘 + 启动链，**不内嵌运行时**。启动链 = 面板不健康时触发守护
（`ocrc start`，supervisor 负责 adopt/spawn）→ 轮询健康 → 开窗加载面板。

# 结构

- `main.js` — Electron 主进程：单实例锁、托盘（打开/新建会话/退出，win32
  关窗到托盘）、`ensureDaemon()` 启动链、加载面板 URL。
- `shell-health.ts` — 可单测的编排纯函数（健康轮询/退避/相位机），主进程
  逻辑的测试替身。

# 状态：scaffold（未打包）

不在 CI、不发布——`main.js` 只能在 Electron 内运行。下一步（shell 项目
启动时）：electron-builder 打包（win nsis / mac dmg）、托盘真实图标、
面板事件透传（新建会话深链）、签名与自动更新。

# 本地试跑

```bash
npm i -D electron           # 仓库根或本目录
npx electron desktop/main.js
```
