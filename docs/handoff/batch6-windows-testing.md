# 批次 6 Windows 移交 —— 全项目测试 + ocrc-remote Windows 面首验
> **已过时（2026-10-19）**：本文件描述的入口/脚本属于**上一代拓扑**（控制端 `-L` 连被控端裸引擎），其中连接页、远程工作区、配置同步、omo 编排面板、`/ocrc-host`、`/ocrc-plan` 与它们的服务端端点、验收脚本已在扩展 **0.9.2 删除**；`scripts/cdp/guest-ui.mjs` 由 `extensions/ocrc/scripts/{preview,audit}.mjs` 取代。保留作为沿革记录。


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

### ③-补：公钥未授权时先部署（2026-10-16 真机实测新增）

**2026-10-16 执行本 handoff 时，③ 直接失败**：本机 `~/.ssh/id_ed25519` 的公钥
**并不在被控机的 `authorized_keys` 里**（batch2 handoff 曾记载「已在」，实测不符）。
verbose 下公钥是**已送出**、被服务端拒绝（`Offering public key: … SHA256:zFigb/…` →
`Permission denied (publickey,...)`）——即不是客户端问题，是对端没授权。

**这是整条链的第一步，不通则后面全部无从谈起**（隧道、工作区、配置桥都走 BatchMode ssh）。
部署一次即可长期有效：

```bash
# 在被控机上（用密码登录一次，或让有权限的人执行）
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJq/p48+6ME/Ym9ErowP6d2HlJMTDKxk+aS6ufnDhbCF bd7pi@Jared_Laptop' >> ~/.ssh/authorized_keys
command -v restorecon >/dev/null && restorecon -R ~/.ssh    # EL7 SELinux
```

然后回到 Windows 复验 ③。**注意**：上例是当前这台 Windows 机的公钥；换机器时用
`ssh-keygen -y -f ~/.ssh/id_ed25519` 或 `cat ~/.ssh/id_ed25519.pub` 取自己的。

> **设计教训（已入列待办）**：这一步目前是纯手工且容易被漏。按目标设计，扩展应能在
> 首次配对时**引导部署凭据**（生成/展示公钥、或一次性密码引导写入），否则「自动检测对端
> 环境」这条链在第一跳就没有立足点。

## 1. 装 openchamber 面板（若已有可跳过）

与批次 2 相同：桌面版 exe（https://github.com/openchamber/openchamber/releases）
或 `npm install -g @openchamber/web`（Node ≥ 24.14）。首次启动设 UI 密码。

## 2. 装扩展（ocrc-remote + ocrc-omo-view）

```powershell
git clone https://github.com/BD7PIL/ocrc.git
# 扩展目录：ocrc\extensions\ocrc-remote 与 ocrc\extensions\ocrc-omo-view
```

面板 → Settings → Extensions → Add extension → folder：

- `ocrc-remote`：指向 `...\ocrc\extensions\ocrc-remote`。装完出现一次 **service
  能力审批**——批准（openchamber 代拉本机进程，这是隧道守护的唯一方式）。
- `ocrc-omo-view`：指向 `...\ocrc\extensions\ocrc-omo-view`，只读。

**添加档案（0.6.0 起是内联表单，不再是弹窗）**：「ocrc Connect」→「添加档案」→ 表单里两格：

- **SSH 目标**：`user@<EL7 IP>[:port]`；
- **私钥路径**（可选）：Windows 上的绝对路径，如 `C:\Users\<你>\.ssh\id_ed25519`；
  **留空** = 用默认 `~/.ssh` 密钥或 ssh-agent（若 §0-② 已启用）。
- 预期：档案创建成功。这份档案会落盘到 `C:\Users\<你>\.config\openchamber\ocrc-connect-profiles.json`（alpha.7 起这就是 Windows 实际路径，待本机确认——见 §6-A）。

> **0.6.0 的重要变化**：0.5.0 及以前这里的输入框是 `window.prompt`——沙箱没有
> `allow-modals`，浏览器直接忽略它并返回 null，所以「添加档案」在真实面板里**从来没能
> 成功过**（`+ 根目录`、提交信息同理）。三处现在都改成了内联表单。若你在旧版上试过、
> 以为是自己填错了，那是对的，不是你的问题。

### 2-补：被控端的引擎从哪来（0.6.0 起面板自己装）

0.5.0 及以前，被控端必须**已经装好并启动** opencode——扩展只会开隧道，引擎不在位就什么也
做不了。0.6.0 起「连接」页多了一块**主机视图**：

1. **四档就绪**逐档报告：① ssh 可达 → ② sh + tar + 可写 `$HOME` → ③ 引擎在位且版本匹配 →
   ④ 远程工作目录可写。不绿的那档直接给出**可执行动作**。
2. 第③档不绿时点**部署引擎**：先出**预演**（官方包名、版本、取件方式、大小、为什么），
   再点**确认部署**。装到被控端的 `~/.opencode/bin`，**不覆盖**你既有的
   `~/.local/bin/opencode`（面板会明确说「不动它」）。
3. 被控端**不出网**时：预演里会出现「下载工件到面板」，先点它，再推送。
4. 项目目录填在「项目与能力」里；「盘点能力」列出这台机器上的 MCP 能力各自差什么
   （密钥 / 网络 / 运行时），需要补隧道时给出**改写前后的 URL**。

> 版本锚点：被控端装的是**面板宿主正在跑的那个 opencode 版本**（镜像，不 follow latest）。
> 面板宿主自己还没有 v2 引擎时，规划会拒绝并如实说明——故意的，不是 bug。

### 2-补二：配置写在哪（0.6.0 改判）

配置同步写**被控端项目目录下的 `opencode.jsonc`**（优先级高于全局；存在 `.jsonc` 就写
`.jsonc`）。**全局层只读不写**——那是你自己的用户级配置。0.5.0 及以前写的是
`~/.config/opencode/opencode.json`（全局），那是设计错误：新落点生效，旧入口直接返回 410。

密钥不会落进配置文件：写盘前字面量密钥换成 `{env:…}` 引用。provider 凭据走单独的
`/auth-sync` 通道（写入被控端引擎的 `auth.json`，0600 + `.ocrc-bak`），需要一次显式确认；
**SSH 私钥/密码、TG bot token 永不离开面板宿主**。

### 2-补三：主机现状交给模型 + 运行时补齐（0.6.0 追加）

- **composer 里的两个命令**：`/ocrc-host`（现状）与 `/ocrc-plan`（待办）。敲下去会变成一张
  chip 贴进对话，内容是四档就绪、引擎版本、能力清单与缺口——**模型读它，人不用再去翻面板**。
  没连主机时会明说「先连上」，不会静默失败；后面可以跟档案名指名一台主机。
- **主机视图多了一块「交给模型」**：「在此项目上新建会话」（目录已是 openchamber 项目时）与
  「贴到当前对话」。前者会如实报首条消息的发送结果（没有模型凭据时 `no-model`，会话仍在）。
- **每项能力会显示它的运行时状态**：已就位 / 待安装 / 装不了（后者写明理由）。点「安装这一项」→
  一次确认 → 被控端跑 `npm install`，落到 `~/.ocrc/runtime/<包名>/<槽位>`（`latest` 或声明的版本）；
  装好后写项目配置时，`npx -y X` 会自动改成目标机上的真实入口（预览里能看到改了什么）。
- **`sessions` 能力**：0.6.0 会多要这一个能力（「在此项目上新建会话」要用）。重装时批准它。
- **重装是必须的**：0.5.0 的产物在面板里跑，主机视图会报 `操作失败 / not found`——新端点还不存在。

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
