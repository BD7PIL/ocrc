# PRODUCT.md — OCRC 产品宪法

> 每个新需求先过这一页。**2026-10-19 重写**：仓库已收缩到只剩远程 openchamber 实例这一条线
> （驾驶舱那一代整体删除，会作为独立的 openchamber 扩展在别的项目里做）。修订需在此文件留痕。

## 第零条：定位

**给"装不上 openchamber"的机器供货，并把它连进桌面 app。**

上游 openchamber 自己的"远程实例"（managed 模式）走对端的 npm/bun + 公网 registry。我们在
**它做不到的地方**补上：glibc 2.17 的老机器、完全离线（air-gap）的机器、没有可用包管理器的
机器。做法是把整套 openchamber（运行时 + 我们 pin 的 opencode + app 本体）**推过去**，而不是
让对端去取。对端自己出不了网时，它的引擎经控制端的中继出网。

三条不可替代的能力，其余全部让给上游：

1. **给装不上的机器供货**（两档兼容包 + 推送，对端零联网）。
2. **引擎 pin 与 CI 跟随**（对端装什么版本由我们钉，`ocrc-follow.yml` 跟上游）。
3. **给无外网的对端供网**（`-R` + 控制端代理；上游的 `-R` 只是端口转发，把引擎指到代理上是我们做的）。

**不替代上游**：面板是 openchamber 自己的（Win/Mac，不 fork）；身份与配对是上游发的；对端
openchamber 的界面、会话、Files/Git 都是它自己的，我们只负责装好、起好、连上。

## 第零点一条：分层归属判据（新需求先过这一条）

| 需求长什么样 | 归谁 |
| --- | --- |
| 面板的界面、会话、文件、git、终端 | **上游 openchamber**（我们不改它，也不在它旁边再做一个） |
| 在远程机器上装/起/连/同步这套能力 | **本仓库** |
| Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机 | **别的项目**（作为独立的 openchamber 扩展；已从本仓库删除） |
| 给"装不上"的机器供货的包与流水线 | **本仓库**（`ocrc-pack.yml` / `ocrc-follow.yml` / `bin-cache`） |

## 第零点二条：兼容硬边界

- **引擎门禁**：被控端的 opencode 必须 `major=2` 且 `>= 2.0.20`。不满足就是错误状态，**绝不
  回落 v1**（对端现有 v1 一律不动，我们装自己的一份到 `~/.ocrc/remote/engine/opencode`）。
- **平台**：被控端 Linux x86_64；**EL7 / glibc 2.17 是支持下限**（两档包里 `legacy-glibc217`
  含重建的 node-pty）。控制端 Win/Mac。
- **Node**：CLI 要求 Node 20+，零运行时依赖。

## 第零点三条：出网策略

- `auto`（默认）**探测**：让对端取 `https://models.dev/api.json`（openchamber 自己取 provider
  目录的地址）。取到 = 直连；取不到 = 经控制端转发；**测不出来 = unknown，也走转发，并如实说
  没测出来**——绝不谎报"没有出网"。
- `relay` / `direct` 是**强制覆盖**，不是"推荐"。
- 判定结果与理由必须**在面板上可见**（卡片 + 状态区），且实例的 env 必须与策略一致（不一致
  就重启实例，不允许"在线但没出网"）。

## 第零点四条：凭据与诚实

- SSH 凭据（密钥/密码）**只在控制端**：密码落 0600 记录，接口只回 `hasSshPassword` 布尔。
- 对端引擎的凭据（`auth.json`）经 ssh stdin 写到 0600，**不回显**；配置里的字面量密钥在写盘前
  换成 `{env:…}`。
- 界面密码由我们生成、只在控制端；面板可看可复制。
- **写被控端必须一次显式确认**（安装、同步、移除都要），预演（plan）只读。
- **面板与状态区不许撒谎**：服务不可达就说"服务不可达"，不显示"还没有服务器"；没探测到就写
  "未知"；找不到的东西写"缺失"，不假装。

## 第零点五条：命名与工件

- 品牌 **OCRC**，机器标识一律 **`ocrc`**：扩展目录 `extensions/ocrc`、`panel.id = ocrc`、
  资产 `ocrc.zip`、tag `ocrc-<ver>` / `ocrc-latest`、镜像分支 `ocrc`。裁决与代价见
  [decisions/2026-10-18-rename-to-ocrc.md](decisions/2026-10-18-rename-to-ocrc.md)。
- 包名 `ocrc-openchamber-pack-<ver>-linux-x64-<tier>.tar.gz`（平铺目录寻址，版本必须在名字里）；
  tag 寻址的靠 tag（zip 不带版本）。旧 tag `ocrc-remote-pack-2.3.3` 保留不动（老扩展的兜底）。

## 第零点六条：面板 = openchamber 的 UI

我们**不自己画一套界面**：面板与状态区的控件用宿主 kit、颜色用宿主 token，`guest.css` 只留布局。
面板只做一条动线：**添加服务器 → 检查并安装 → 启动 → 创建配对链接**（复制 → 到 app 的服务器
列表「导入链接」粘贴）。状态区只读，一行一台。

## 第零点七条：组件装配（2026-10-20）

**ocrc 是通用执行器，不是组件的上游。** 它只认组件自己带来的安装契约：

- 每个组件（reeve / opencode-deep-memory / 以后新增的）在**自己的仓库根**放 `provision.json`，
  随 npm 包发布。它声明：引擎插件 spec、离线目录回退、需要预置的二进制（版本 + sha256 + 落点）、
  openchamber 扩展 zip、需要同步的配置、装完的验证项。
- ocrc 的流程固定：**读清单 → 取件（控制端）→ 校验 → 推送到对端 → 登记 `plugins`（并集）→
  装扩展（失败不阻断）→ 逐项验证**。加一个组件 = 加一份清单，不改 ocrc 代码。
- 版本 pin 在 `ops/components.json`；`OCRC_<NAME>_PIN` 可覆盖。
- **禁止**：ocrc import 组件源码、vendor 组件、在代码里出现组件内部概念（如 Bifrost）；
  组件也不得依赖 ocrc 才能运行——它们的 README 必须给出按 `provision.json` 手动安装的等价步骤。
- 单写者规则不变：`plugins` 由 ocrc 并集写入；`agents.*.model` 与组件自己的链/台账由组件写。
  对端 v1 `plugin` 键原样保留（openchamber 所有）。

## 明确不做

- **不给上游的界面打补丁**（不 fork openchamber，不改它的项目菜单/文件面板/git 面板）。
- **不在扩展里重做上游已有的面**：文件浏览、git、终端、会话——对端 openchamber 自己有。
- **不给被控端装第二套东西**：`managed` 模式的 npm/bun 安装会与我们的实例争端口与引擎所有权，
  同机不得混用（上游 external 模式才是我们的接法）。
- **不做中心化多租户/账号/订阅**；单人自用起步，企业内网受控环境延伸，local-first。
- **不做"面板内嵌被控端界面"**：guest 的 CSP（`frame-src`）与对端的 `frame-ancestors` 都不允许，
  走 app 自己的服务器列表。
- **不让控制端凭据离开控制端**；不写桌面 app 自己的 `settings.json`（那是它的面）。
- **不追上游的未发布功能**：`uploadBundleOverSsh` 之类留作上游 feature request，不自建平行路径。

## 历史

2026-10-05 经架构 grilling 定稿；10-06 定位落案 + 双拓扑；10-07 ZCode 平替驾驶舱落案；
10-14 基座换位（面板让位 openchamber）；10-16/17 面板侧 provisioning 与对端能力；
**10-19 收缩到只剩远程实例**（驾驶舱删除，见 [AGENTS.md](../AGENTS.md) 的「已删除」）。
本文件此前关于驾驶舱的条文（双拓扑、backend 域模型、功能范围、远控会话与配对、UI 原则的
调色/字号/动效寄存器）随那些代码一起作废；裁决沿革在 `docs/decisions/` 与 `docs/research/`。
