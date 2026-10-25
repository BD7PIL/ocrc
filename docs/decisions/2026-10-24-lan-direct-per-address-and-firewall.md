# 裁决 2026-10-24：LAN 直连成套——地址只由用户点名 + 防火墙由 ocrc 开（扩展 0.11.2）

## 背景

0.11.1 给了 bind=lan 开关，但配对链接的 LAN 候选自动取了 `hostname -I` 的**第一段**
（EL7 实测选了 192.168.22.202）。用户指着自己的 ssh 地址 192.168.26.101 问"你凭什么擅自
改 22/选别的地址"——多网卡机器的第一段不是契约。同时 2610 直连被 EL7 firewalld 拦着
（demo 用户无免密 sudo，polkit 拒绝探测），开防火墙这件事当时被留给了用户手工。

## 裁决一：地址只来自显式点名，永不自动挑选

- 对端有多少个地址，配对卡就给多少行（`laninfo` op：`hostname -I` **全量** →
  `inspected.ips: string[]`，每行 = 直连 URL + 控制端 TCP 实测徽章 + 生成按钮）。
- 点哪个按钮，链接的直连候选（`--server`）就是哪个；桥端（`pairLink(id, { address })`）
  与 CLI（`pairlink --lan <地址>`）都只接受显式地址，`hostname -I` 只做菜单。
- 0.11.1 的"第一段"猜测路径删除；`inspected.ip`（单数）一并退役为 `ips`。

## 裁决二：防火墙由 ocrc 开，但边界收得很窄

- 生成链接前 `ensureLanPort`：控制端实测 → 闭集探测（firewalld/ufw/none/unknown；
  polkit 拒绝记 unknown，绝不猜）→ 只放行**我们的实例端口**一条规则（firewalld
  `--permanent --add-port=<port>/tcp + --reload`；ufw `allow <port>/tcp`）→ 复测。
- 三态收口，修不动就不造假链接：
  1. 可达 → 出链接（含"本次打开的"）；
  2. **needs-sudo** → 回 `{ needsSudo: true, backend }`，面板收一次密码重试；
  3. 修不动（已放行但连不上 = 提示查 0.0.0.0 监听；无后端 = 请手工放行）→ 不出链接。
- **sudo 密码纪律**（与 ssh 密码同款）：`sudo -S` 从 ssh stdin 喂入，不进 argv
  （shell 历史 + ps 可见）、不落盘、不回显、不记住；免密 sudo（`sudo -n`）自动走。
- 放行后的端口**保持开放**（用户要的就是开放态）；ocrc 不碰 ssh/22，不关用户自己开过的
  任何规则，也不做"bind 拨回 loopback 时自动关端口"（显式要求才经同一通道关闭）。

## 为什么面板要一次密码框而不是先配免密 sudo

EL7 的 demo 用户没有免密 sudo 是既成事实；免密 sudo 是机器主人的安全决定，不该由 ocrc
代改（写 sudoers 比开一条端口危险得多）。needs-sudo 握手把决定权还给用户：要么当场输一次
密码（即用即弃），要么自己去配免密——两条路 ocrc 都接着。

## 关联

- [2026-10-24-relay-off-conditional-and-lan-bind.md](2026-10-24-relay-off-conditional-and-lan-bind.md)
  （bind 开关本体 + relay 条件注入；本档只收 LAN 直连的收尾）
- CHANGELOG 2.0.0-alpha.20 / 扩展 0.11.2
