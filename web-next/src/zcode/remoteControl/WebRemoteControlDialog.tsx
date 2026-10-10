// @ts-nocheck
// WebRemoteControlDialog.tsx (ocrc override) — P-remote 远控会话对话框。
//
// vite/tsconfig 的 `@/WebRemoteControlDialog.js` alias 指到本文件（vendor 原
// 文件零字节改动，不进 PATCHES.md）。双栏布局对齐官方 v3.15.1 弹层语义：
//   左栏「扫码连接」= ocrc 远控会话卡（本文件的增量）——start/refresh/stop
//     走 loopback 限定管理端点；二维码取自免认证 onboarding 面；刷新的确认
//     文案沿用官方「刷新二维码」语义（新 epoch = 已发会话凭证全废）。
//   右栏「Bot Channel」= vendor 原样（weixin/feishu/lark/telegram + 管理）。
// 非 loopback 浏览器：管理按钮请求 403 后置灰并给出原因（服务端兜底）。
import { memo, useCallback, useEffect, useState } from "react";
import type { BotProvider } from "@zcode/shared";
import {
  Bot as BotIcon,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  Copy,
  Square,
  XIcon,
} from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<
  BotProvider,
  "weixin" | "feishu" | "lark" | "telegram"
>;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

// ── ocrc 远控会话卡 ──────────────────────────────────────────────────────────

type SessionStatus = {
  active: boolean;
  epoch: number;
  startedAt?: number;
  pendingExpiresAt?: number;
  paired: number;
};

type OnboardingResponse = {
  status?: "on" | "off";
  url?: string;
  svg?: string;
  expiresAt?: number;
  paired?: number;
  error?: string;
};

function ocrcAuthHeaders() {
  try {
    return { Authorization: `Bearer ${localStorage.getItem("ocrc.token") ?? ""}` };
  } catch {
    return {};
  }
}

async function postSession(op: "start" | "refresh" | "stop"): Promise<{ ok: boolean; status?: SessionStatus; error?: string }> {
  try {
    const res = await fetch(`/api/pair/session/${op}`, {
      method: "POST",
      headers: ocrcAuthHeaders(),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, status: (await res.json()) as SessionStatus };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchOnboarding(): Promise<OnboardingResponse> {
  try {
    const res = await fetch("/api/pair/onboarding");
    return (await res.json()) as OnboardingResponse;
  } catch {
    return { error: "host 不可达" };
  }
}

/** 扫码连接卡：status 轮询 + start/refresh/stop + 二维码（onboarding 面）。 */
function ScanSessionSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [qr, setQr] = useState<{ url: string; svg: string; expiresAt?: number } | null>(null);
  const [mgmtBlocked, setMgmtBlocked] = useState<string | null>(null); // 403/409 原因
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // 打开时拉一次状态 + 二维码；会话 on 时 15s 轮询已连接数。status 端点
  // 403/409 时携带原因——非 loopback 浏览器的置灰提示由服务端兜底。
  const reload = useCallback(async () => {
    const [st, ob] = await Promise.all([
      fetch("/api/pair/session/status", { method: "POST", headers: ocrcAuthHeaders() })
        .then(async (r) => {
          if (r.ok) return { status: (await r.json()) as SessionStatus, blocked: null as string | null };
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return { status: null, blocked: body.error ?? `HTTP ${r.status}` };
        })
        .catch(() => ({ status: null, blocked: "host 不可达" })),
      fetchOnboarding(),
    ]);
    setStatus(st.status);
    setMgmtBlocked(st.blocked);
    if (ob.status === "on" && ob.url && ob.svg) {
      setQr({ url: ob.url, svg: ob.svg, expiresAt: ob.expiresAt });
    } else {
      setQr(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void reload();
    const t = setInterval(() => {
      void reload();
    }, 15_000);
    return () => clearInterval(t);
  }, [open, reload]);

  const act = async (op: "start" | "refresh" | "stop") => {
    setBusy(true);
    const r = await postSession(op);
    setBusy(false);
    if (!r.ok) {
      setMgmtBlocked(r.error ?? "操作失败");
      return;
    }
    setMgmtBlocked(null);
    if (op === "stop") setStatus(r.status ?? null);
    logger.info("[RemoteSession] session " + op, { epoch: r.status?.epoch });
    await reload();
  };

  const copyLink = async () => {
    if (!qr?.url) return;
    try {
      await navigator.clipboard.writeText(qr.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）——链接本身仍在卡片上可扫 */
    }
  };

  const active = status?.active === true;

  return (
    <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-start gap-2">
        <QrCode className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">扫码连接</div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            局域网内扫码进入，获得临时会话凭证；刷新或停止会话即全部下线（桌面锚设备不受影响）。
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        {qr ? (
          <div
            className="max-h-56 w-56 overflow-hidden rounded-lg border border-border bg-white p-2"
            // onboarding 的 svg 由 host 端 qrcode 库生成（margin=1），白底保证可扫
            dangerouslySetInnerHTML={{ __html: qr.svg }}
          />
        ) : (
          <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-dashed border-border text-ui-sm text-foreground-subtle">
            {active ? "二维码即将刷新…" : "会话未开启"}
          </div>
        )}
        <div className="text-ui-sm text-foreground-subtle">
          {active ? (
            <>
              会话进行中 · 已连接{" "}
              <span className="font-medium text-foreground">{status?.paired ?? 0}</span> 台设备
            </>
          ) : (
            "开启后手机扫码进入（LAN 直连，无中继）"
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        {!active ? (
          <Button
            type="button"
            size="lg"
            className="w-full justify-center gap-2 enabled:cursor-pointer"
            disabled={busy || !!mgmtBlocked}
            onClick={() => void act("start")}
          >
            <QrCode className="size-4" />
            开启会话
          </Button>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="justify-center gap-2 enabled:cursor-pointer"
                disabled={busy || !!mgmtBlocked}
                onClick={() => setConfirmRefresh(true)}
              >
                <RefreshCw className="size-3.5" />
                刷新二维码
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="justify-center gap-2 enabled:cursor-pointer"
                disabled={busy || !!mgmtBlocked}
                onClick={() => setConfirmStop(true)}
              >
                <Square className="size-3.5" />
                停止
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="justify-center gap-2 enabled:cursor-pointer"
              disabled={!qr}
              onClick={() => void copyLink()}
            >
              <Copy className="size-3.5" />
              {copied ? "已复制" : "复制链接"}
            </Button>
          </>
        )}
        {mgmtBlocked ? (
          <p className="text-ui-xs text-foreground-subtle">
            本机管理不可用：{mgmtBlocked}（请在主机上执行 ocrc pair / ocrc pair --stop）
          </p>
        ) : null}
      </div>

      {/* 刷新确认——官方同款语义：旧二维码/已发凭证立即失效，所有已连接手机被踢 */}
      <AlertDialog open={confirmRefresh} onOpenChange={setConfirmRefresh}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刷新二维码？</AlertDialogTitle>
            <AlertDialogDescription>
              当前二维码立即失效，所有通过本次会话连接的手机将被断开，需要重新扫码。桌面端不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRefresh(false);
                void act("refresh");
              }}
            >
              刷新
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 停止确认——关闭扫码入口并断开全部会话设备 */}
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停止远程控制会话？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭扫码入口，所有会话设备立即下线。桌面端不受影响；随时可以重新开启。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmStop(false);
                void act("stop");
              }}
            >
              停止
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] =
    useState<RemoteControlBotProvider | null>(null);

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-6rem)] max-w-3xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix（沿用 vendor 原注释）：弹窗贴近窗口顶部，显式关闭按钮更稳命中。
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5">
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>
                    {intl.formatMessage({ id: "webRemoteControl.title" })}
                  </DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* ocrc fork（P-remote）：左 = 扫码连接（远控会话卡），右 = Bot Channel 原样。 */}
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <ScanSessionSection open={open} />
              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(
                      entry.provider,
                    );

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        <ProviderIcon
                          provider={entry.provider}
                          className="size-12 shrink-0"
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({
                              id: "webRemoteControl.botChannel.configure",
                            })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
