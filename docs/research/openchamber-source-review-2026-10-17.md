# openchamber 源码复盘（v2.4.0 浅克隆）——我们做错了什么、还剩什么

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

日期：2026-10-17 ｜ 依据：`openchamber/openchamber` tag `v2.4.0`（浅克隆在 `~/openchamber-ref`，143M）
触发：用户指出我连续两天交付"奇怪东西"，并要求我读源码后重新复盘。

---

## 0. 一句话结论

**openchamber 自己已经做完了"连接与授权"这一整层**（SSH 远程实例、配对链接/设备令牌、Private Relay、桌面隧道）。
我们唯一不可替代的是**给"自己装不上 openchamber"的机器供货**（glibc 2.17 / 离线 / 没有可用 npm 或 bun）。
其余部分——写桌面实例列表、复制三项、status 区的隧道读数——都是我在重复上游已有能力，且做得更差。

---

## 1. 我这几天说错的三件事（同一根因）

| 我说过的 | 事实 | 依据 |
|---|---|---|
| "面板没法加对端，最后一步 CLI 不可替代" | 面板有 `添加对端 / 预演 / 确认装机 / 启动 / 停机 / 删档案 / 刷新`，每行还带 `state / 引擎版本 / node 版本` 徽标 | `extensions/ocrc-remote/src/panel/RemoteInstance.tsx` |
| "2.4.0 里我没找到导入链接的实现" | 实现完整：深链解析 + 确认提示 + 复用 Import Link 的 redeem 路径 | `packages/electron/pairing-deep-link.mjs`、`packages/ui/src/lib/desktopSsh.ts`、`docs/content/docs/connect-devices.mdx` |
| "我们该把 SSH 密码存进记录（并做 askpass）" | 平台**已有**一次性配对链接 → 每设备独立可撤销 token，且"存密码"本身也是官方支持的选项 | `docs/remote-instances.mdx` §Credentials、`docs/connect-devices.mdx` |

**根因**：我在 minified bundle 上 grep，没命中就下结论。两次"没有"都是错的，两次都是我只翻了一个 bundle。
**更深的失误**：`packages/docs/content/docs/remote-instances.mdx` 只有 48 行，把这两天我反复推断的东西写得很清楚。
我一次都没读它，也从没从用户的座位把流程点一遍——我验证的是**我自己能验证的东西**（CI、哈希、远端机器），
所以交付物在技术上成立、在使用上不成立。

---

## 2. openchamber 实际提供了什么（源码/文档依据）

| 能力 | 说明 | 实现位置 |
|---|---|---|
| SSH 远程实例 | 桌面专属。`managed`（**自己在对端装并启动**）/ `external`（连已运行的）；逐阶段显示"检查连接→准备→起服务→转发端口" | `packages/electron/ssh-manager.mjs`、`docs/remote-instances.mdx` |
| 端口转发 | 每个实例可加 **`-L` / `-R` / `-D`(SOCKS)**；`-R` 是原生支持的，不是我们的发明 | `ssh-manager.mjs:1234-1259`、`docs/ssh-hosts-proxying.mdx` |
| SSH 主机导入 | 读本机 `~/.ssh/config` 的主机列表（`parseSshConfigCandidates`） | `ssh-manager.mjs`、`docs/ssh-hosts-proxying.mdx` |
| 密码认证 | 用户自选是否保存；**Windows 走 PowerShell askpass**（`askpass.ps1` + `.cmd` 包装 + `SSH_ASKPASS_REQUIRE=force`） | `ssh-manager.mjs:262-317, 445-448, 568-585` |
| 配对链接 / 设备令牌 | 一次性 secret → **每设备独立 token，与 UI 密码分离，可撤销，跨重启存活**；三档传输（仅本机 / 仅家庭网络 / 任何地方） | `docs/connect-devices.mdx`、`packages/electron/pairing-deep-link.mjs` |
| 深链 | 注册 `openchamber://`；收到链接**先弹确认**再 redeem | `pairing-deep-link.mjs`、`main.mjs`（`setAsDefaultProtocolClient`/`handleDeepLinks`） |
| Private Relay | 自家 E2E 中继，"任何地方"零配置；按需启停；密钥在 `relay-identity.json` | `docs/private-relay.mdx` |
| 桌面隧道 | cloudflared / ngrok 公网 URL + token 保护 + 二维码 | `docs/desktop-tunnels.mdx` |
| 扩展/guest | 面板 + 状态区 + service（宿主代起进程、一次性审批）+ git 安装自更新 | `docs/extensions.mdx`、`web/server/lib/guests/*` |
| 对端安装（managed） | 在**对端**跑 `bun add -g` 或 `npm install -g --prefix $HOME/.openchamber/npm-global @openchamber/web@<ver>` | `ssh-manager.mjs:1117` |

**关于 `uploadBundleOverSsh`（重要）**：源码里只有两处引用——`ssh-manager.mjs:878` 的 sanitizer 和
`ui/src/lib/desktopSsh.ts` 的读写——**v2.4.0 没有任何实现消费它**。也就是说上游 schema 已经预留了
"把 bundle 推过去而不是在对端装"这条路，但还没做。这条直接关系到我们的定位（见 §4）。

---

## 3. 「其他 OpenChamber 服务器」与「远程实例」为什么是两个东西

不是重复，是**两层**：

- **①② 配对（服务端 / 客户端）** = 身份与路由：谁可以连、以什么身份连、走本机/局域网/中继。
  每设备一个可撤销 token，一次性链接投递，**与 UI 密码分离**。
- **③ 远程实例** = 可达性与供给：没有路由时怎么到达那台机器，以及要不要顺手把它装起来。

文档自己的定位：配对是 "the recommended way... no ports to open and no addresses to type"；
SSH 留给中继覆盖不到的场景（无公网，或对端还没有 openchamber）。
`docs/remote-instances.mdx` §Connection links 明确写：**"If a remote machine already runs OpenChamber,
the easiest way to connect the desktop app is a pairing link."**

**我们的场景正好落在这一句上**：我们装完对端之后，对端就是"already runs OpenChamber"。

---

## 4. 复盘：OCRC 还剩什么

### 不可替代（保留）
1. **给装不上 openchamber 的机器供货**：glibc 2.17 / 离线 / 无可用 npm-bun。managed 模式做不到——
   实测断网时 `npm install` 三跳 ENOTFOUND → 回落五个月旧缓存 → `ETARGET`。我们的两档 CI 包 + 推送是唯一通路。
2. **引擎 pin 与 CI 跟随**：服务于上面那条（对端引擎版本由我们钉）。
3. **给无公网对端的引擎供网**（`-R` + 控制端代理）：上游的 `-R` 只是端口转发，把引擎指到代理上是我们做的。
4. **IM 通道**：上游没有。

### 已被上游覆盖（应删/应改）
1. `ocrc remote connect --desktop-add` 与「复制三项」→ 改用**配对链接**（上游推荐路径，且更安全）。
2. `status` 区的 profile/隧道读数 → 与实例面不一致，且是旧批次遗留。
3. "把 SSH 密码存进我们自己的记录" → 不需要：配对链接给的是每设备 token。

### 战略选项（比自建更值）
上游 schema 里已有 `uploadBundleOverSsh`。如果上游实现它，我们的 provisioning 就能**退化成"供货"**：
原生 managed 流程拿我们的包去装。建议作为上游 feature request 推进，而不是长期维护一条平行路径。

### 必须由你回答的战略问题
**EL7 / 离线这一档在生产里有多少台？** 如果是一两台，整个 provisioning + CI 包体系的投入产出比要重算；
如果是一批，OCRC 的正确定位就是"给装不上 openchamber 的机器供货的那一层"，其余全部让给上游。

---

## 5. 修正后的计划（如果继续）

1. **面板走通"一次点击"**：加对端 → 预演 → 装机 → 启动 → 在对端跑
   `openchamber connect-url --port <实例端口> --server http://127.0.0.1:<本地转发端口> --name <标签>`
   → 面板给「打开」（深链，app 会先弹确认）与「复制」；`-L` 由扩展 service 自己持（`ensureForward` 已有）。
2. **删**：`--desktop-add`、复制三项、status 区的旧读数。
3. **补**：面板的日志入口（service 已有 `logs` op）、status 区改读实例状态。
4. **验收方式改变**：我点一遍再交，不再拿 CI 绿灯当交付证明。
