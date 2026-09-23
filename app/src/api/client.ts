/** 前端 ⇄ 核心：只有 HTTP（/__ud/*）和 WS（/__ud/ws）两条路（doc/01 §4.9）。
 *  启动数据由核心在托管 /__app/ 时注进 window.__UD_APP（server/src/serve.ts）。 */
/** 托管本页的核心：属于某个项目（name/dir 有值）或是桌面壳的 hub（hub=true，只有全局路由） */
export interface Boot { url: string; token: string; name: string | null; title: string | null; dir: string | null; ws: string; front: "app" | "legacy"; hub?: boolean }
export interface ProjectHandle { url: string; token: string; ws: string; name: string; title: string; dir: string }
export interface Envelope<T = unknown> { ok: boolean; data?: T; errors?: { code?: string; message: string }[] }
export interface UdEvent { type: "hello" | "job" | "chat" | "write" | "fs"; projectDir: string | null; payload: unknown; at: string }

declare global { interface Window { __UD_APP?: Boot } }

export function boot(): Boot | null { return window.__UD_APP ?? null; }

export class Core {
  constructor(public readonly url: string, public readonly token: string, public readonly ws: string) {}
  static fromBoot(b: Boot): Core { return new Core(b.url, b.token, b.ws); }
  private u(route: string): string { return `${this.url.replace(/\/$/, "")}/__ud/${route}${route.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`; }
  async get<T = unknown>(route: string): Promise<Envelope<T>> {
    const r = await fetch(this.u(route)); return r.json();
  }
  async post<T = unknown>(route: string, body: unknown): Promise<Envelope<T>> {
    const r = await fetch(this.u(route), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }); return r.json();
  }
  /** 事件流：断了 2s 后重连；返回停止函数 */
  events(onEvent: (e: UdEvent) => void, onState?: (s: "open" | "closed") => void): () => void {
    let ws: WebSocket | null = null; let stopped = false; let timer: number | null = null;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(`${this.ws}?token=${encodeURIComponent(this.token)}`);
      ws.onopen = () => onState?.("open");
      ws.onmessage = (m) => { try { onEvent(JSON.parse(String(m.data))); } catch { /* 坏行丢掉 */ } };
      ws.onclose = () => { onState?.("closed"); if (!stopped) timer = window.setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); ws?.close(); };
  }
}
