import type { HostAdapter } from "./types";
import { createBrowserHost } from "./browser";

/* 桌面壳（Electron，M9-2）通过 preload 把能力挂在 window.umbraHost 上；有它就是 desktop，否则 browser。
   这是前端里唯一知道「壳」存在的地方。 */
declare global { interface Window { umbraHost?: Partial<HostAdapter> & { kind: "desktop" } } }
export type { HostEvent } from "./types";

let host: HostAdapter | null = null;
export function getHost(api: Parameters<typeof createBrowserHost>[0]): HostAdapter {
  if (host) return host;
  const browser = createBrowserHost(api);
  const d = window.umbraHost;
  host = d ? { ...browser, ...d, kind: "desktop", capabilities: d.capabilities ?? browser.capabilities } as HostAdapter : browser;
  return host;
}
export type { HostAdapter } from "./types";
