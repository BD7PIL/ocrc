import { ProxyAgent, type Dispatcher } from "undici";

/**
 * Telegram egress through a corporate/blocked-network proxy.
 *
 * api.telegram.org is unreachable in some environments (firewalled VMs,
 * enterprise networks). grammy's fetch accepts an undici `dispatcher` in
 * baseFetchConfig — a ProxyAgent routes ALL Bot API traffic (getMe, polling,
 * send*) through the proxy. Precedence: TELEGRAM_PROXY > HTTPS_PROXY >
 * https_proxy (TELEGRAM_PROXY exists so a machine-wide HTTPS_PROXY for other
 * tools can be overridden independently).
 *
 * Config lives in ~/.ocrc/config.env like every other key:
 *   TELEGRAM_PROXY=http://proxy.corp.lan:8080
 */
export function buildTelegramFetchConfig(): { dispatcher: Dispatcher } | undefined {
  const proxy =
    process.env.TELEGRAM_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim();
  if (!proxy) return undefined;
  return { dispatcher: new ProxyAgent(proxy) };
}
