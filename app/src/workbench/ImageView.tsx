import { useCallback, useEffect, useRef, useState } from "react";
import type { Core } from "../api/client";
import type { ReadFileResult, Selection } from "../api/types";
import { toast } from "../ui/Toast";
import { fmtSize } from "./DirView";

/** 图片视图（S14 形制，M8-9 / M8-10）。
 *  只看、缩放、圈一块区域带一句话给 AI —— **不做图像编辑**（`01` §4.2 明写不做）。
 *  圈选坐标一律用**原图像素**，和缩放无关：AI 拿到的是「这张图上 (x,y,w,h) 这一块」，
 *  缩放只是人看得清楚些。
 *  通道吃不吃图由 `supportsImage` 决定；不支持时圈选入口是禁用态，**原因常显**，不藏在 hover 里。 */
const ZOOMS = [0.25, 0.5, 1, 2, 4];

export function ImageView({ core, path, supportsImage, channelLabel, onSelection, onProbed }: {
  core: Core; path: string; supportsImage: boolean; channelLabel: string; onSelection: (s: Selection | null) => void; onProbed: () => void;
}) {
  const [probing, setProbing] = useState(false);
  const [info, setInfo] = useState<ReadFileResult | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [picking, setPicking] = useState(false);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [note, setNote] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const src = `${core.url}${path.split("/").map(encodeURIComponent).join("/")}`;
  const isSvg = /\.svg$/i.test(path);

  useEffect(() => {
    setInfo(null); setRect(null); setDrag(null); setNote(""); setPicking(false);
    setZoom(isSvg ? 2 : "fit");   // svg 可无损放大，默认 200%（设计侧定的）
    void core.get<ReadFileResult>(`file?path=${encodeURIComponent(path)}`).then((r) => { if (r.ok && r.data) setInfo(r.data); });
  }, [core, path, isSvg]);

  const fitScale = useCallback(() => {
    const el = box.current, w = info?.width ?? 0, h = info?.height ?? 0;
    if (!el || !w || !h) return 1;
    return Math.min(1, (el.clientWidth - 48) / w, (el.clientHeight - 48) / h);
  }, [info]);
  const scale = zoom === "fit" ? fitScale() : zoom;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA/.test((document.activeElement?.tagName ?? ""));
      if (typing) return;
      if (e.key === "0") { setZoom("fit"); }
      if (e.key.toLowerCase() === "r" && supportsImage) { setPicking((p) => !p); setDrag(null); }
      if (e.key === "Escape") { setPicking(false); setDrag(null); setRect(null); setNote(""); onSelection(null); }
    };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [supportsImage, onSelection]);

  /** 屏幕坐标 → 原图像素 */
  const toImage = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round((clientX - r.left) / scale), y: Math.round((clientY - r.top) / scale) };
  };
  const onDown = (e: React.MouseEvent) => {
    if (!picking || !img.current) return;
    e.preventDefault();
    const a = toImage(e.clientX, e.clientY);
    const move = (ev: MouseEvent) => {
      const b = toImage(ev.clientX, ev.clientY);
      setDrag({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      setDrag((d) => { if (d && d.w > 4 && d.h > 4) { setRect(d); setPicking(false); } return null; });
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };

  /** 把圈中的那一块裁出来（原图像素），连同坐标与备注带进会话 */
  const send = async () => {
    if (!rect || !img.current) return;
    let dataUrl: string | null = null;
    try {
      const c = document.createElement("canvas");
      c.width = rect.w; c.height = rect.h;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img.current, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      dataUrl = c.toDataURL("image/png");
    } catch { dataUrl = null; }   // svg / 跨源画不出来就只带坐标
    const name = path.split("/").pop() ?? path;
    onSelection({
      kind: "region",
      label: `${name} ${rect.w}×${rect.h}`,
      detail: [
        `${path} 区域 x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}（原图像素，整图 ${info?.width}×${info?.height}），位置：${where(rect, info?.width ?? 0, info?.height ?? 0)}`,
        note.trim(),
      ].filter(Boolean).join("\n"),
      image: dataUrl ?? undefined,
    });
    toast("已带进会话", note.trim() ? "区域 + 你写的那句话" : "区域坐标已带上", "ok");
  };

  const cap = !supportsImage;
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-bg min-h-0">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-border bg-panel shrink-0 text-xs">
        <span className="font-semibold truncate">{path.split("/").pop()}</span>
        <span className="font-mono text-muted">{(info?.kind === "image" ? (path.split(".").pop() ?? "").toUpperCase() : "")} · {info?.width ?? "?"}×{info?.height ?? "?"} · {info ? fmtSize(info.size) : "…"}</span>
        {isSvg && <span className="lvl" style={{ background: "var(--tool-ok-soft)", color: "var(--tool-ok)" }}>矢量 · 可无损缩放</span>}
        <span className="flex-1" />
        <button className="ib" onClick={() => setZoom(ZOOMS.filter((z) => z < scale).pop() ?? 0.25)} title="缩小">－</button>
        <button className="btn sm ghost" onClick={() => setZoom("fit")} title="适配窗口（0）">{zoom === "fit" ? "适配" : `${Math.round(scale * 100)}%`}</button>
        <button className="ib" onClick={() => setZoom(ZOOMS.find((z) => z > scale) ?? 4)} title="放大">＋</button>
        <div className="flex flex-col items-end">
          <button className={`btn sm ${picking ? "on" : ""}`} disabled={cap} onClick={() => { setPicking((p) => !p); setRect(null); onSelection(null); }} title={cap ? undefined : "圈一块区域带给 AI（R）"}>⬚ 圈选 {picking ? "中" : "R"}</button>
        </div>
      </header>
      {cap && (
        <div className="px-3 h-8 flex items-center gap-2 text-xs shrink-0 border-b" style={{ background: "var(--tool-warn-soft)", borderColor: "var(--tool-warn-border)", color: "var(--tool-warn)" }}>
          <span>当前大脑通道不支持图片（{channelLabel}），圈选给 AI 用不了。</span>
          <span className="flex-1" />
          {/* 「不支持」是按模型名猜的，可能猜错 —— 给一条硬判据：发一张纯色小图问它什么颜色 */}
          <button className="btn sm" disabled={probing} onClick={async () => {
            setProbing(true);
            const r = await core.post<{ supportsImage: boolean; why: string }>("ai_probe_image", {});
            setProbing(false);
            if (!r.ok) { toast("探不了", r.errors?.[0]?.message, "error"); return; }
            toast(r.data?.supportsImage ? "这条通道能看图" : "这条通道确实看不了图", r.data?.why, r.data?.supportsImage ? "ok" : undefined);
            onProbed();
          }}>{probing ? "正在探…" : "探一次"}</button>
        </div>
      )}
      <div ref={box} className="flex-1 min-h-0 overflow-auto grid place-items-center p-6" style={{ background: "repeating-conic-gradient(var(--tool-panel-2) 0 25%, transparent 0 50%) 50% / 16px 16px" }}>
        <div className="relative" style={{ lineHeight: 0 }} onMouseDown={onDown}>
          <img ref={img} src={src} alt={path} draggable={false}
            style={{ width: info?.width ? info.width * scale : undefined, height: info?.height ? info.height * scale : undefined, cursor: picking ? "crosshair" : "default", userSelect: "none" }} />
          {(drag ?? rect) && (
            <div className="absolute pointer-events-none" style={{
              left: (drag ?? rect)!.x * scale, top: (drag ?? rect)!.y * scale,
              width: (drag ?? rect)!.w * scale, height: (drag ?? rect)!.h * scale,
              border: drag ? "1px dashed var(--tool-accent)" : "2px solid var(--tool-accent)",
              background: "color-mix(in srgb, var(--tool-accent) 12%, transparent)",
            }}>
              {drag && <span className="absolute -top-6 left-0 px-1.5 h-5 rounded-sm bg-accent text-onAccent text-[11px] font-mono leading-5 whitespace-nowrap">{drag.w}×{drag.h}</span>}
              {rect && !drag && <>{[["-4px", "-4px"], ["calc(100% - 4px)", "-4px"], ["-4px", "calc(100% - 4px)"], ["calc(100% - 4px)", "calc(100% - 4px)"]].map(([l, t], i) => <span key={i} className="absolute w-2 h-2 bg-accent" style={{ left: l, top: t }} />)}</>}
            </div>
          )}
        </div>
      </div>
      {rect && (
        <footer className="px-3 py-2 flex items-center gap-2 border-t border-border bg-panel shrink-0 text-xs">
          <span className="font-mono text-muted shrink-0">x {rect.x} · y {rect.y} · {rect.w}×{rect.h}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} autoFocus
            placeholder="对这一块说一句…（「这个按钮的颜色是什么」）" className="flex-1 h-8 px-3 rounded border border-border bg-bg outline-none focus:border-accent" />
          <button className="btn sm ghost" onClick={() => { setRect(null); setNote(""); setPicking(true); onSelection(null); }}>重圈</button>
          <button className="btn sm primary" onClick={() => void send()}>带进会话 ⏎</button>
        </footer>
      )}
      {!rect && (
        <footer className="h-7 px-3 flex items-center gap-3 border-t border-border bg-panel shrink-0 text-[11px] text-muted font-mono">
          {!cap && <span>R 圈选</span>}<span>0 适配</span><span>＋/－ 缩放</span>
          <span className="flex-1" /><span>只看、缩放{cap ? "" : "、圈选"}；不做图像编辑</span>
        </footer>
      )}
    </div>
  );
}

/** 圈中那一块在整图里的方位，按九宫格说人话。
 *  模型从坐标推方位会推错（实测：240×160 的图上 x=130 y=90 被说成「左上方」），
 *  而这件事我们自己算得出来 —— 算好了直接给它，比让它猜可靠。 */
function where(r: { x: number; y: number; w: number; h: number }, W: number, H: number): string {
  if (!W || !H) return "未知";
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const col = cx < W / 3 ? "左" : cx > (W * 2) / 3 ? "右" : "中";
  const row = cy < H / 3 ? "上" : cy > (H * 2) / 3 ? "下" : "中";
  if (col === "中" && row === "中") return "正中";
  if (col === "中") return `${row}方居中`;
  if (row === "中") return `${col}侧中部`;
  return `${row}${col}角`;
}
