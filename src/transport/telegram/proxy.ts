import { ProxyAgent, type Dispatcher } from "undici";

/**
 * Telegram egress through a corporate/blocked-network proxy.
 *
 * api.telegram.org is unreachable in some environments (firewalled VMs,
 * enterprise networks). grammy's fetch accepts an undici `dispatcher` in
 * baseFetchConfig — a ProxyAgent routes ALL Bot API traffic (getMe, polling,
 * send*) through the proxy.
 *
 * Precedence: panel credential (channels.json `credentials.proxy`, set from
 * the 机器人管理 panel — restart-effective like the panel token) >
 * TELEGRAM_PROXY > HTTPS_PROXY > https_proxy. The TELEGRAM_PROXY env exists
 * so a machine-wide HTTPS_PROXY for other tools can be overridden
 * independently.
 */
export function buildTelegramFetchConfig(panelProxy?: string): { dispatcher: Dispatcher } | undefined {
  const proxy =
    panelProxy?.trim() ||
    process.env.TELEGRAM_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim();
  if (!proxy) return undefined;
  return { dispatcher: new ProxyAgent(proxy) };
}
