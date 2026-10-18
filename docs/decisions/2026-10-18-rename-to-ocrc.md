# 2026-10-18 — 名字收敛到单一仓库名 `ocrc`

> 取代 [2026-10-17-convergence.md](2026-10-17-convergence.md) 里"扩展叫 `ocrc-remote`"的那条命名决定。

## 决定

**机器标识一律 `ocrc`，不再有 `-remote` / `ext-` 这类限定词。**

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 扩展目录 | `extensions/ocrc-remote` | `extensions/ocrc` |
| 清单 | `name: ocrc-remote`、`panel.id: ocrc-remote`、显示名 `OCRC Remote` | `ocrc` / `ocrc` / `OCRC` |
| 发布资产 | `ocrc-remote.zip` | `ocrc.zip` |
| 钉版本 tag | `ocrc-remote-<ver>` | `ocrc-<ver>` |
| 通道 tag | `ocrc-remote-latest` | `ocrc-latest` |
| 镜像分支（git 装法） | `ext-ocrc-remote` | `ocrc` |
| 发布工作流 | `.github/workflows/ocrc-ext.yml` | `.github/workflows/ocrc-extension.yml` |
| 档案文件 | `ocrc-connect-profiles.json` / `OCRC_CONNECT_PROFILES` | `ocrc-profiles.json` / `OCRC_PROFILES` |

另外删掉 `extensions/ocrc-connect/`——那是改名留下的**空目录**（git 不跟踪空目录，所以一直没人发现）。

## 为什么

1. 仓库只有一个（`ocrc`），里面的东西就叫 `ocrc`。`-remote` 是"相对谁"的限定词，而这里没有相对物；
   `ext-` 是"它是个扩展"的限定词，而目录 `extensions/` 已经说了这件事。两个限定词叠起来
   （`ext-ocrc-remote`）最没有信息量。
2. 旧名 `ocrc-connect` 是**死名字**（连接页已撤），档案文件却还带着它，找东西的人会以为还有那条通道。

## 代价（必须知道）

- **`panel.id` 从 `ocrc-remote` 变成 `ocrc` → 已装的那份是"另一个扩展"**：要在 Settings → Extensions
  里卸掉旧的（id `ocrc-remote`，0.8.2），再装新的。旧安装的服务进程不会自己消失。
- **安装 URL 变了**：git 装法 `https://github.com/BD7PIL/ocrc#ocrc`（能自更新）；
  zip 通道 `.../releases/download/ocrc-latest/ocrc.zip`（不能自更新）。
- **旧 tag/release 不动**（`ocrc-remote-0.8.2`、`ocrc-remote-latest`、`ocrc-remote-pack-2.3.3`）：
  它们是不可变的历史指针，其中 `ocrc-remote-pack-2.3.3` 还是给 2026-10-17 之前构建的扩展留的兜底
  （那份扩展内嵌的是旧包名）。**不再向它们发布**，但也不删——删掉会让老安装的 URL 直接 404。
- **版本提到 0.9.0**：`panel.id` 变更对安装是破坏性变更，不是补丁。

## 没有改的（有意）

- `ocrc-omo-view`：本来就是 `ocrc-` 前缀，第二段是件类，符合约定。
- `ocrc-openchamber-pack-<ver>-linux-x64-<tier>.tar.gz`：第二段 `openchamber` 是**件类**
  （包里装的是什么），不是限定词；`OCRC_PACK_DIR` 是平铺镜像目录，版本必须留在文件名里。
- 源码里的领域词 `remote-instance*` / `remote-fs` / `remote-tools` / `src/cli/remote.ts`：
  它们是"远程实例"这个**领域概念**，不是后缀。改名只会让 `instance.ts` 变得指代不明。
- `docs/handoff/*`、`docs/research/*`、`CHANGELOG.md`：当时事实的记录，不回改（本文即新记录）。
