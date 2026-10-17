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

**方式 A（推荐，git clone）**——仓库的扩展目录就是安装根（构建产物已提交），clone 后零构建直接装：

```
git clone https://github.com/BD7PIL/ocrc.git
# 两个扩展目录：ocrc/extensions/ocrc-remote 与 ocrc/extensions/ocrc-omo-view
```

面板 → Settings → Extensions → **Add extension** → 选 **folder**：

- ocrc-remote：指向 `extensions/ocrc-remote/`。装完出现一次 **service 能力审批**（openchamber 代为拉起本机进程）——批准。
- ocrc-omo-view：指向 `extensions/ocrc-omo-view/`，纯只读，审批面最小（sessions 能力）。

**方式 B（Release 附件）**：下载 Release 附件 `ocrc-extensions-*.tar.gz` 解压（内部目录已是安装形状），同样 folder 安装。

> 手动/folder 安装不参与自更新，升级 = 重新 clone + 重装（或走下节的 CI 扩展仓库路线）。

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
- **ocrc-remote 的 service 有本机进程权限**：这是 openchamber 扩展模型里唯一能守护 SSH 进程的方式，装时一次性审批。
- **面板宿主重启后**：若只有一个 SSH 档案，service 会自动重连；多个档案需手动点一次（刻意保持歧义手动）。

## 5. 出问题时回传什么

- 面板日志：Settings → About/Logs（或 `~/.config/openchamber/logs/`）。
- service 日志：面板宿主上 `~/.config/openchamber/ocrc-connect-profiles.json` 确认档案落盘；隧道卡死时在本机终端手跑 `ssh -N -L 4096:127.0.0.1:4096 user@host` 看报错。
- 回传格式：`[扩展名] 现象 / 期望 / 面板日志末 20 行`。

## 6. 后续（稳定后）

CI 推送到 `BD7PIL/ocrc-ext-connect` 与 `BD7PIL/ocrc-ext-omo` 两仓库（分支根 = 扩展根，产物已提交）→ 面板改用 git URL 安装 → 自更新按 package.json `version` 递增自动走。

---

## 批次 4 增补（2.0.0-alpha.4）：远程工作区（ocrc-remote 0.2.0）

> 前置：上面第 1 节的隧道已通。工作区面板在**同一个「ocrc Connect」扩展里**，
> 面板顶部新增「连接 / 远程工作区」两个 tab。

### 7. 新验收：远程工作区

1. **配置工作区根**：「远程工作区」tab →「+ 根目录」→ 填被控机上的绝对路径
   （如 `/home/<user>/project`）。根目录存在 host.storage，service 每次请求都会
   复核白名单——面板改了立即生效，且面板被篡改也扩不了权。
2. **浏览**：点目录进子层，「← 上级」回退；文件带大小。
3. **编辑**：点文件打开（>512KB 拒开）→ 改 → 「保存」。保存 = 远端 mktemp →
   原文件备份为 `*.bak` → 原子 mv。远端断线时保存会报错而不是写半个文件。
4. **git**：状态/diff/暂存全部/提交；Work Status 徽标会带当前分支
   （`ocrc 隧道：已连 · 引擎可达 · master`）。
5. **安全边界（刻意行为）**：白名单外路径一律 403；`..` 一律 400；
   未连接隧道时工作区 tab 显示提示而不是空列表。

### 8. 本机已验证的部分（无需重测）

`extensions/ocrc-remote/scripts/accept-workspace.sh` 在 EL7 本机 loopback SSH
活体跑通全链：browse → read → atomic write(.bak) → diff → stage → commit →
status clean，403/400 守卫生效。你在 Win/Mac 上要验证的只是**同一套端点在
openchamber 宿主里的 UI 呈现**（iframe + host.storage + service 桥）。

### 9. 批次 4 已知边界

- diff 视图只取前 200KB（更大走命令行）；git 面板不做分支切换/合并——那是
  「远程工作区查看+轻编辑」的边界，不是 git 客户端。
- 徽标分支取**第一个**白名单根（多根时以第一个为准）。
- 面板编辑器无语法高亮（IIFE 面不引重依赖，刻意保持）。
