/** host adapter（doc/01 §4.9 H7、doc/12 M7-3）：前端里所有「宿主能力」只从这里走。
 *  两份实现：browser（降级，说清为什么不可用）与 desktop（Electron 壳，M9-2）。
 *  前端别的目录**不许**出现 Electron / Tauri 的 API —— 验收就是 grep 只命中 host/。 */
export interface HostCapability { ok: boolean; why?: string }
export interface HostAdapter {
  readonly kind: "browser" | "desktop";
  /** 弹目录选择框；浏览器里没有，返回 null 并由 capabilities.pickDirectory.why 说明 */
  pickDirectory(opts?: { title?: string }): Promise<string | null>;
  /** 在访达 / 资源管理器里显示 */
  revealInFinder(path: string): Promise<void>;
  /** 用系统浏览器打开外部链接 */
  openExternal(url: string): Promise<void>;
  /** 系统通知；浏览器里退化成页面内 toast（由调用方接 onFallback） */
  notify(n: { title: string; body?: string }): Promise<void>;
  setTitle(title: string): void;
  capabilities(): Record<"pickDirectory" | "revealInFinder" | "openExternal" | "notify" | "setTitle", HostCapability>;
  /** 壳主动发来的事：菜单「打开目录」、上次没正常退出（未落盘提示）。浏览器宿主没有这些事。 */
  onEvent?(cb: (e: HostEvent) => void): () => void;
}
export type HostEvent = { type: "open-dir"; dir: string } | { type: "dirty-restart"; at: string | null } | { type: "go-home" };
