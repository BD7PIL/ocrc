# 批次 6 Windows 移交 —— 全项目测试 + ocrc-connect Windows 面首验

> EL7 侧开发与测试已全部完成（1071 后端测试 + 扩展 56 单测 + 25 步端到端验收全绿）。
> 本文档是**唯一**需要你在 Windows 日常机上做的部分，也是 2.0 拓扑第一次在真实
> Windows 面板宿主上跑。预计 15 分钟。
> alpha.7 在 EL7 侧修掉了 4 个 Windows 阻塞点（见 §6），但真机行为仍是首次验证——
> 任何一条不符预期都请按 §5 回传，那正是这轮移交的目的。

## 0. 前置检查（PowerShell，全部应在 Windows 本机执行）

```powershell
# ① ssh 在不在 PATH（Windows 可选功能 OpenSSH 客户端；没有就：
#    设置 → 应用 → 可选功能 → 添加功能 → OpenSSH 客户端）
ssh -V
# 预期：OpenSSH_for_Windows_x.x 或类似版本行。报错=未安装。

# ② ssh-agent 状态（Windows 默认 Disabled——这是 Windows 侧第一大坑）
Get-Service ssh-agent
# 预期若 Status=Stopped 且 StartType=Disabled，启用它（管理员 PowerShell）：
#   Set-Service ssh-agent -StartupType Automatic
#   Start-Service ssh-agent
# 然后注册私钥：ssh-add $env:USERPROFILE\.ssh\id_ed25519
# （或者跳过 agent，直接在扩展里填 keyPath——见 §2 的「添加档案」。）

# ③ key 能不能免密登上被控机（把 user/host 换成你的 EL7）
ssh user@your-el7-host "echo ok"
# 预期：输出 ok，任何密码/口令短语提示都会让隧道失败（BatchMode 刻意设计）。
```

## 1. 装 openchamber 面板（若已有可跳过）

与批次 2 相同：桌面版 exe（https://github.com/openchamber/openchamber/releases）
或 `npm install -g @openchamber/web`（Node ≥ 24.14）。首次启动设 UI 密码。

## 2. 装扩展（ocrc-connect + ocrc-omo-view）

```powershell
git clone https://github.com/BD7PIL/ocrc.git
# 扩展目录：ocrc\extensions\ocrc-connect 与 ocrc\extensions\ocrc-omo-view
```

面板 → Settings → Extensions → Add extension → folder：

- `ocrc-connect`：指向 `...\ocrc\extensions\ocrc-connect`。装完出现一次 **service
  能力审批**——批准（openchamber 代拉本机进程，这是隧道守护的唯一方式）。
- `ocrc-omo-view`：指向 `...\ocrc\extensions\ocrc-omo-view`，只读。

**添加档案（新增了 keyPath 输入）**：「ocrc Connect」→「添加档案」→ 先填
`user@<EL7 IP>`，再填**私钥路径**（第二个提示框）：

- 填 Windows 上的绝对路径，如 `C:\Users\<你>\.ssh\id_ed25519`；
- **留空** = 用默认 `~/.ssh` 密钥或 ssh-agent（若 §0-② 已启用）。
- 预期：档案创建成功。这份档案会落盘到 `C:\Users\<你>\.config\openchamber\ocrc-connect-profiles.json`（alpha.7 起这就是 Windows 实际路径，待本机确认——见 §6-A）。

## 3. 验收清单（按序，每步「预期」不符即停，按 §5 回传）

### A. 隧道与连接

1. **连接**：点档案旁「连接」。
   - 预期：`隧道 已连` + `引擎 可达` 两枚绿 pill；Work Status 出现「ocrc 隧道」徽标。
   - 不通时先手跑：`ssh -N -L 4096:127.0.0.1:4096 user@host`（PowerShell 直跑）看报错。

### B. 远程工作区（Windows 面首验）

2. **根目录**：「远程工作区」tab →「+ 根目录」→ 输入 `C:\Users` 试一下。
   - 预期：**红色错误提示**「工作区根必须是被控机（Linux）上的绝对路径，以 / 开头…」
   - 这是对 Windows 误操作的新增防呆（alpha.6 会静默忽略）。✅ alpha.7 新 UI
3. **正确根目录**：再输入被控机上的真实路径（如 `/home/user/project`）。
   - 预期：文件树列出远端目录；点击文件可读；编辑保存后远端出现 `.bak`。
4. **git 面板**：status/diff/stage/commit 逐个点。
   - 预期：被控机仓库的状态实时反映。

### C. 配置同步（批次 5 面的 Windows 首验——alpha.7 修了路径解析）

5. **「配置同步」tab** → 刷新。
   - 预期：显示一个 `configPath`。**Windows 上应为 `C:\Users\<你>\AppData\Roaming\opencode\opencode.json`**
     （若你装过 openchamber 且它写在别处，记录实际值回传——这正是 §6-A 要验证的点）。
   - alpha.6 在 Windows 上此 tab 会空白（fallback 到了 `~/.config`）。
   - 有源配置时「预览」应列出 agents/mcp/providers 段名；「应用」把面板配置桥到被控机
     （被控机侧生成 `opencode.json.ocrc-bak`）。

### D. omo 编排（批次 5.1 面的 Windows 首验——alpha.7 修了远端路径写入）

6. **「omo 编排」tab**：确认能读到被控机 `~/.config/opencode/oh-my-opencode-slim.json`
   （EL7 上先跑一次 omo-slim install 生成基准配置）。
   - 预期：显示预设下拉、fallback 控件、per-agent 链只读树。
7. **改一个预设**：下拉换预设 → 保存。
   - 预期：返回「已写入」；EL7 上 `oh-my-opencode-slim.json` 的 `preset` 键变了，
     且出现 `oh-my-opencode-slim.json.ocrc-bak`。
   - alpha.7 之前这条链路的写入落到了被控机一个字面名为 `$HOME` 的错误目录——
     本步骤是修复后的首次真机验证。
8. **omo 编排树**（ocrc-omo-view）：EL7 上发起一个 omo 多代理任务 → 树实时出现。

### E. 面板宿主重启韧性

9. 重启 openchamber（或重启 Windows）。
   - 预期：只有一个档案时 service 自动重连；多个档案需手动点一次连接。

## 4. 已知边界（如实记录，不是 bug）

- 换引擎要重启面板一次（openchamber 只在启动时探测外部引擎）。
- 手机 / VS Code 不加载扩展（隧道跑在面板宿主上）。
- allowedRoots 只认**被控机 POSIX 绝对路径**（`/` 开头）——Windows 盘符路径被
  有界拒绝（产品边界：被控端永远 Linux）。
- ssh 断线时 Windows 无进程组语义，残留 ssh 进程可能需要任务管理器手动清理
  （`Get-Process ssh` 查看）。

## 5. 出问题时回传什么

```powershell
# 面板日志
Get-ChildItem "$env:USERPROFILE\.config\openchamber\logs" | Sort-Object LastWriteTime -Desc | Select-Object -First 3
Get-Content "$env:USERPROFILE\.config\openchamber\logs\<最新>.log" -Tail 20

# service 档案落盘
Get-Content "$env:USERPROFILE\.config\openchamber\ocrc-connect-profiles.json"

# 手动复现隧道
ssh -N -L 4096:127.0.0.1:4096 user@host
```

回传格式：`[扩展名] 现象 / 期望 / 日志末 20 行`。

## 6. alpha.7 修掉的 Windows 阻塞点（供验收时对照）

| # | 修复 | 验收步 |
|---|---|---|
| A | 面板宿主配置路径加 `%APPDATA%\opencode` 分支（win32）——配置同步 tab 在 Windows 不再空白。**真机落点待确认** | §C-5 |
| B | 工作区「+ 根目录」对 Windows 盘符路径显式报错（原静默忽略） | §B-2 |
| C | 添加档案支持 **keyPath**（Windows ssh-agent 默认 Disabled 的对冲） | §2 |
| D | omo 配置远端写入路径：`$HOME` 单引号冻结 bug（写到字面 `$HOME` 目录）——批次 5.1 全链真机从未写对过 | §D-7 |

另有一个连带修复：断开连接后 fs/git/omo/config 面现在正确返回 409（原来残留
「active profile」）。

## 7. 后续（稳定后）

- 扩展独立仓库（`BD7PIL/ocrc-ext-connect` / `ocrc-ext-omo`）+ git URL 安装 +
  每小时自更新——需要先建仓，当前手动 folder 安装不参与自更新。
- CI 已产出 `ocrc-extensions-*.tar.gz` artifact（Actions → CI → artifacts），
  Windows 免 clone 下载安装；正式 Release 附件待扩展仓库落地后挂接。
