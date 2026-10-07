// @ts-nocheck
// settings/RemotesSection.tsx — ocrc 远程主机分区（N5 裁决②：ocrc remotes 在
// /z/ 原生管理）。ZCode 的远程语义是桌面 SSH 连工作区，浏览器客户端做不了；
// ocrc 的远程是 host 侧 SSH 隧道 + 远端引擎注册，启用后远端会话自动并入
// /api/sessions（/z/ 侧栏即见、流式同源）。本分区只做管理面：列表/状态/启停/
// 探测/删除/新增，全走 ocrc /api/remotes。文案内联中文（fork 特有分区）。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

function auth() {
  try {
    return { Authorization: `Bearer ${localStorage.getItem("ocrc.token") ?? ""}` };
  } catch {
    return {};
  }
}

interface OcrcRemote {
  id: string;
  name?: string;
  host: string;
  port: number;
  user?: string;
  remotePort: number;
  enabled: boolean;
  hasPassword?: boolean;
}

interface OcrcRemoteStatus {
  state?: string;
  detail?: string;
  localPort?: number;
}

export function RemotesSection() {
  const [remotes, setRemotes] = useState<OcrcRemote[]>([]);
  const [statusById, setStatusById] = useState<Record<string, OcrcRemoteStatus | null>>({});
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", host: "", user: "", port: "22", remotePort: "4097" });
  const [probing, setProbing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/remotes", { headers: auth() });
      const data = res.ok ? await res.json() : { remotes: [] };
      setRemotes(data.remotes ?? []);
      setStatusById(Object.fromEntries((data.remotes ?? []).map((r) => [r.id, r.status ?? null])));
    } catch {
      /* host 不可达时保持现有列表 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (r: OcrcRemote, enabled: boolean) => {
    try {
      const res = await fetch(`/api/remotes/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...auth() },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast(enabled ? "已启用：隧道建立后远端会话将并入任务列表" : "已停用");
    } catch (e) {
      toast(`操作失败：${e instanceof Error ? e.message : e}`);
    }
    void refresh();
  };

  const remove = async (r: OcrcRemote) => {
    try {
      await fetch(`/api/remotes/${r.id}/delete`, { method: "POST", headers: auth() });
      toast("已删除");
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : e}`);
    }
    void refresh();
  };

  const probe = async (r: OcrcRemote) => {
    setProbing(r.id);
    try {
      const res = await fetch(`/api/remotes/${r.id}/inspect`, { method: "POST", headers: auth() });
      const data = await res.json().catch(() => ({}));
      const inspection = data.inspection;
      toast(
        inspection
          ? `探测完成：platform=${inspection.platform ?? "?"} opencode=${inspection.opencode ? "有" : "无"} auth=${inspection.auth ? "有" : "无"}`
          : `探测失败：${data.error ?? res.status}`,
      );
      void refresh();
    } catch (e) {
      toast(`探测失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setProbing(null);
    }
  };

  const add = async () => {
    if (!form.host.trim()) {
      toast("host 必填");
      return;
    }
    try {
      const res = await fetch("/api/remotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth() },
        body: JSON.stringify({
          name: form.name.trim() || undefined,
          host: form.host.trim(),
          user: form.user.trim() || undefined,
          port: Number(form.port) || 22,
          remotePort: Number(form.remotePort) || 4097,
          enabled: false,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? String(res.status));
      }
      toast("已添加（默认停用，启用后建立隧道）");
      setAdding(false);
      setForm({ name: "", host: "", user: "", port: "22", remotePort: "4097" });
      void refresh();
    } catch (e) {
      toast(`添加失败：${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label="远程主机"
          description="ocrc host 通过 SSH 隧道纳管远端 opencode 引擎；启用后远端会话自动并入任务列表，/z/ 侧栏即见、消息流式同源。添加后建议先「探测」确认远端环境。"
          control={
            <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
              {adding ? "收起" : "添加主机"}
            </Button>
          }
        />
        {adding ? (
          <div className="grid grid-cols-1 gap-3 border-t border-border px-4 py-4 sm:grid-cols-2">
            <label className="text-ui-sm text-foreground-subtle">
              名称（可选）
              <Input className="mt-1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="家里这台" />
            </label>
            <label className="text-ui-sm text-foreground-subtle">
              主机 *
              <Input className="mt-1" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="192.168.1.20" />
            </label>
            <label className="text-ui-sm text-foreground-subtle">
              SSH 用户（可空）
              <Input className="mt-1" value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} placeholder="demo" />
            </label>
            <label className="text-ui-sm text-foreground-subtle">
              SSH 端口
              <Input className="mt-1" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
            </label>
            <label className="text-ui-sm text-foreground-subtle">
              远端 opencode 端口
              <Input className="mt-1" value={form.remotePort} onChange={(e) => setForm((f) => ({ ...f, remotePort: e.target.value }))} />
            </label>
            <div className="flex items-end">
              <Button onClick={() => void add()}>保存</Button>
            </div>
          </div>
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        {!loaded ? (
          <SettingsRow label="加载中…" />
        ) : remotes.length === 0 ? (
          <SettingsRow
            label="还没有远程主机"
            description="添加并通过 SSH 探测后，远端引擎的会话会直接出现在 /z/ 的任务列表里。"
          />
        ) : (
          remotes.map((r) => {
            const status = statusById[r.id];
            const stateText =
              !r.enabled ? "已停用" : status?.state ?? "未知";
            return (
              <SettingsRow
                key={r.id}
                label={
                  <span className="flex items-center gap-2">
                    {r.name || r.host}
                    <span className="rounded-md bg-surface px-2 py-0.5 text-ui-sm text-foreground-subtle">{stateText}</span>
                  </span>
                }
                description={`${r.user ? `${r.user}@` : ""}${r.host}:${r.port ?? 22} → 远端 ${r.remotePort}${status?.localPort ? `，本地隧道 :${status.localPort}` : ""}${status?.detail ? `，${status.detail}` : ""}`}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={probing === r.id} onClick={() => void probe(r)}>
                      <RefreshCw className="size-4" />
                      {probing === r.id ? "探测中…" : "探测"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void remove(r)}>
                      <Trash2 className="size-4" />
                    </Button>
                    <Switch checked={r.enabled} onCheckedChange={(v) => void toggle(r, v)} aria-label={`启用 ${r.name || r.host}`} />
                  </div>
                }
              />
            );
          })
        )}
      </SettingsGroupCard>
    </div>
  );
}
