/** 应用 → 嵌入的 S2 壳的指令通道（S2 再转给内层 iframe 里的点选桥）。壳的 iframe 带 data-shell。 */
export function shellCmd(cmd: string, value?: unknown): void {
  const f = document.querySelector<HTMLIFrameElement>('iframe[data-shell="1"]');
  f?.contentWindow?.postMessage({ source: "umbradesign-app", type: "cmd", cmd, value }, "*");
}
