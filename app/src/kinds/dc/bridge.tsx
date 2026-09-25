import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ShellState } from "../../api/types";
import type { ViewContext } from "../context";

export type PreviewMode = "shell" | "raw" | "code";
export const PRESETS = ["PC 1440", "笔记本 1280", "iPhone 390", "自适应"];
const SHELL0: ShellState = { selectOn: false, preset: 0, zoom: 1, draftTheme: "light", picked: false, busy: false, editHint: null, checkNote: null, apiErr: null };

/** 画布与 S2 嵌入壳之间那座 postMessage 桥（M8-15b 从 `Canvas.tsx` 提上来）。
 *
 *  **为什么非提不可**：第七轮把工具栏定成统一的一条横带，而画布的开关
 *  （宽度档、缩放、点选、稿的浅深色）**全都住在 iframe 里** ——
 *  读它们要收 `shell-state` 消息，改它们要发 `cmd` 消息。
 *  工具栏搬出画布组件的那一刻，这座桥就得跟着搬到两边都够得着的地方。
 *
 *  这是四种格式里唯一一个「搬工具栏 = 搬架构」的。别的三种只是把 useState 挪个位置。
 */
export interface DcBridge {
  mode: PreviewMode; setMode: (m: PreviewMode) => void;
  shell: ShellState;
  /** iframe 的 ref —— `View` 把 iframe 挂上来，这里才发得出命令 */
  frame: React.RefObject<HTMLIFrameElement>;
  src: string;
  /** 稿**本身**的地址（不带 S2 嵌入壳）—— 演示全屏和「在浏览器打开」用它 */
  rawSrc: string;
  cmd: (c: string, value?: unknown) => void;
  reload: () => void;
  present: boolean; setPresent: (v: boolean) => void;
  file: string;
}

const Ctx = createContext<DcBridge | null>(null);
export const useDc = (): DcBridge => {
  const v = useContext(Ctx);
  if (!v) throw new Error("dc 的 Provider 没包上 —— 工作台必须用 mod.Provider 裹住 View / Toolbar / Panels");
  return v;
};

export function DcProvider({ ctx, children }: { ctx: ViewContext; children: ReactNode }) {
  const { project, store, path: file } = ctx;
  /* 预览模式记在盘上，换稿不重置 —— 用户挑好的看法是长期偏好。
     走 ctx.mem 而不是 localStorage 直接读写：它已经按格式加了命名空间。 */
  const [mode, setModeRaw] = useState<PreviewMode>(() => ctx.mem.get("previewMode", "shell" as PreviewMode));
  const setMode = (m: PreviewMode) => { ctx.setPicked(null); setModeRaw(m); ctx.mem.set("previewMode", m); };
  const [shell, setShell] = useState<ShellState>(SHELL0);
  const [present, setPresent] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const seen = useRef(false);

  const rawSrc = `${project.url}${encodeURIComponent(file).replace(/%2F/g, "/")}`;
  const src = mode === "shell"
    ? `${project.url}${encodeURIComponent("S2-单稿预览壳.dc.html")}?file=${encodeURIComponent(file)}&embed=1`
    : rawSrc;
  const cmd = useCallback((c: string, value?: unknown) => {
    frame.current?.contentWindow?.postMessage({ source: "umbradesign-app", type: "cmd", cmd: c, value }, "*");
  }, []);
  const reload = useCallback(() => {
    seen.current = false;
    if (frame.current) frame.current.src = src;
    if (mode === "code") void store.fetchSource(file);
  }, [src, mode, store, file]);

  useEffect(() => { seen.current = false; setShell(SHELL0); }, [file, mode]);
  useEffect(() => { if (mode === "code") void store.fetchSource(file); }, [mode, file, store]);

  // S2 → 应用：选中 / 清除 / 评论变了 / 壳状态
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string; payload?: Record<string, unknown> };
      if (!m || m.source !== "umbradesign-s2") return;
      if (m.type === "picked" && m.payload) ctx.setPicked({ file: (m.payload.file as string) || file, node: m.payload.node as string, tag: (m.payload.tag as string) || "" });
      if (m.type === "cleared") ctx.setPicked(null);
      if (m.type === "comments-changed") void store.fetchComments(file);
      if (m.type === "shell-state" && m.payload) {
        const p = m.payload as Partial<ShellState>; const first = !seen.current; seen.current = true;
        setShell((s) => ({ ...s, ...p }));
        /* 第一帧且还是默认档时，按详情区的实际宽度自动缩一下 —— 1440 的稿塞进 900 的区里
           不缩的话一进来就是横向滚动条 */
        if (first && p.preset === 0 && (p.zoom === 1 || !p.zoom)) {
          const w = (frame.current?.parentElement?.clientWidth ?? 0) - 24;
          if (w > 0 && w < 1440) cmd("zoom", Math.max(0.3, Math.floor(w / 1440 * 20) / 20));
        }
      }
    };
    window.addEventListener("message", on); return () => window.removeEventListener("message", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, store, cmd]);

  // 落盘 / 回退之后刷新预览
  useEffect(() => {
    const e = store.lastEvent; if (!e || e.type !== "write") return;
    const p = e.payload as { file?: string }; if (p.file === file) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.lastEvent]);

  /* 「重新加载预览」由文件 `⋯` 里那一项触发。走事件是因为 `menu` 是个纯函数、
     拿不到 React context —— 它只能说「要重载」，重载的动作在这里。 */
  useEffect(() => {
    const on = () => reload();
    window.addEventListener("ud-dc-reload", on); return () => window.removeEventListener("ud-dc-reload", on);
  }, [reload]);

  /* 演示全屏归这个模块自己 —— **只有设计稿能演示**，工作台不必替它记一个 state。
     Esc 退出由 `Present` 自己听（它要的是 fullscreenchange，不是 keydown）。 */
  useEffect(() => {
    if (!present) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") setPresent(false); };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [present]);

  return <Ctx.Provider value={{ mode, setMode, shell, frame, src, rawSrc, cmd, reload, present, setPresent, file }}>{children}</Ctx.Provider>;
}
