# 批次 2 面板侧 handoff —— Win/Mac 上的动作清单

> 本机（EL7）侧开发与测试已全部完成；这是唯一需要你在 Win/Mac 日常机上做的部分。
> 预计 10 分钟。做完后：面板零环境变量直连这台 EL7 的 opencode 引擎 + omo 编排树可视化。

## 1. 装 openchamber 面板（约 5 分钟，只此一次）

二选一：

- **CLI/Web 模式**（要求 Node ≥ 24.14）：
  ```
  npm install -g @openchamber/web
  openchamber
  ```
- **桌面版**：从 https://github.com/openchamber/openchamber/releases 下载（macOS dmg / Windows exe），自带 opencode CLI。

首次启动设一个 UI 密码（`OPENCHAMBER_UI_PASSWORD` 或首启引导）。

## 2. 装两个扩展（各约 1 分钟）

扩展产物随 Release 附件分发（`ocrc-extensions-0.1.0.tar.gz`），先下载解压得到两个目录：

```
ocrc-connect/    # 隧道扩展（panel + status + service）
ocrc-omo-view/   # omo 编排视图扩展（panel）
```

面板 → Settings → Extensions → **Add extension**：

- ocrc-connect：选 **folder** 安装（指向解压出的 `ocrc-connect/` 目录）。
  装完会出现一次 **service 能力审批**（openchamber 将代为拉起一个本机进程）——批准。
- ocrc-omo-view：同样 folder 安装，纯只读，审批面最小（sessions 能力）。

> 备选（拿到 git 仓库分发后）：直接粘仓库 URL 安装，自带每小时自更新。手动装的扩展不参与自更新，升级 = 重装。

## 3. 验收清单（按序）

1. **隧道**：右栏打开「ocrc Connect」→「添加档案」→ 填 `user@<EL7 的 IP>`（端口 22）→ 点「连接」。
   - 预期：`隧道 已连` + `引擎 可达` 两枚绿 pill；Work Status 区出现「ocrc 隧道」徽标。
   - 原理：SSH 本地转发落地 `127.0.0.1:4096`——openchamber 启动时自动探测该端口，**零环境变量**。若面板先于隧道启动，重启一次 openchamber 即可（它只在启动时探测外部引擎）。
2. **SSH 认证**：走 key（`~/.ssh/id_ed25519` 已在被控机 `authorized_keys`）。不支持密码交互——这是刻意设计（Windows 无 sshpass）。
3. **omo 编排**：左栏打开「omo 编排」→ 在 EL7 上经 TG 或面板发起一个 omo-slim 编排任务 → 树应实时出现 orchestrator 节点 + 子代理分支（点击子节点跳转会话）。
   - 若显示「暂无编排会话」：确认被控端 opencode 配置里 omo-slim ≥ 3.0.4 且任务真的走了多代理分派（单 agent 直答不会产生子会话）。

## 4. 已知边界（如实记录，不是 bug）

- **换引擎要重启面板**：扩展触碰不到 openchamber server 的引擎配置；隧道建立后若面板没认出引擎，重启 openchamber 一次。
- **手机 / VS Code 不加载扩展**：隧道跑在面板宿主上，手机经面板正常用会话（只是看不到这两个扩展的面板）。
- **ocrc-connect 的 service 有本机进程权限**：这是 openchamber 扩展模型里唯一能守护 SSH 进程的方式，装时一次性审批。
- **面板宿主重启后**：若只有一个 SSH 档案，service 会自动重连；多个档案需手动点一次（刻意保持歧义手动）。

## 5. 出问题时回传什么

- 面板日志：Settings → About/Logs（或 `~/.config/openchamber/logs/`）。
- service 日志：面板宿主上 `~/.config/openchamber/ocrc-connect-profiles.json` 确认档案落盘；隧道卡死时在本机终端手跑 `ssh -N -L 4096:127.0.0.1:4096 user@host` 看报错。
- 回传格式：`[扩展名] 现象 / 期望 / 面板日志末 20 行`。

## 6. 后续（稳定后）

CI 推送到 `BD7PIL/ocrc-ext-connect` 与 `BD7PIL/ocrc-ext-omo` 两仓库（分支根 = 扩展根，产物已提交）→ 面板改用 git URL 安装 → 自更新按 package.json `version` 递增自动走。
