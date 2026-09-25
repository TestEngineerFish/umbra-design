import { PopItem, PopSep, Popover, usePopover } from "../ui/Popover";
import { Glyph, ICON } from "../ui/Glyph";
import type { MenuItem, ViewContext } from "./context";

/** 文件工具栏的共用零件（M8-15，形制按设计侧第七轮的 S11）。
 *
 *  **形制共用、内容各出**：段组长什么样、尺寸钮怎么排、`⋯` 怎么弹，都在这儿写一遍；
 *  每种格式只说「我有哪几组、每组几档」。以前四个视图各画一条工具栏，
 *  行高 34/40、按钮 22/24 各不相同，并排时一眼就看出来不是一套。
 */

export interface SegItem {
  label: string;
  active: boolean;
  onPick: () => void;
  title?: string;
  /** path，走 `ui/Glyph` 的那套（直接抄稿里的 `d`） */
  icon?: string;
  /** 开关型（点开点关），不是单选型。开着时用弱强调色而不是抬起效果 —— 
   *  单选是「我在哪一档」，开关是「这个功能开着」，两件事不该长一样。 */
  toggle?: boolean;
  disabled?: boolean;
}

export function Seg({ label, items }: { label: string; items: SegItem[] }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 p-0.5 bg-panel2 border border-border rounded shrink-0">
      {items.map((it) => (
        <button key={it.label} onClick={it.onPick} aria-pressed={it.active} title={it.title ?? it.label} disabled={it.disabled}
          className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            it.active
              ? (it.toggle ? "bg-accentSoft text-accent font-semibold" : "bg-panel text-text font-semibold shadow-sm")
              : "text-text2 hover:text-text"}`}>
          {it.icon && <Glyph d={it.icon} size={12} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** 尺寸读数钮：**平时只是一个读数**，点开才有档位（第七轮把宽度下拉和三颗缩放钮合成了这一颗）。
 *  只有画布和图片有它 —— 别的格式没有「多宽」「多大」这回事。 */
export function SizeBtn({ label, title, widths, zoomPct, onZoom, onFit, extra }: {
  label: string;
  title: string;
  /** 画布宽度档位；图片没有这一段，传 undefined */
  widths?: Array<{ label: string; px: string; on: boolean; pick: () => void }>;
  zoomPct: number;
  onZoom: (delta: number) => void;
  onFit: () => void;
  /** 挂在缩放那一行右边的额外一颗 */
  extra?: React.ReactNode;
}) {
  const pop = usePopover();
  return (
    <div className="relative flex shrink-0">
      <button ref={pop.anchorRef as React.RefObject<HTMLButtonElement>} onClick={pop.toggle} aria-expanded={pop.open} title={title}
        className={`flex items-center gap-1.5 h-6 pl-2 pr-1.5 rounded-sm font-mono text-[11px] tabular-nums text-text2 hover:bg-hover hover:text-text ${pop.open ? "bg-hover" : ""}`}>
        {label}
        <Glyph d={ICON.caretDown} size={11} stroke={1.6} className="text-muted" />
      </button>
      <Popover pop={pop} align="end" width={232}>
        <div className="p-1">
          {widths && widths.length > 0 && <>
            <div className="px-2 pt-1.5 pb-1 text-[11px] text-muted">画布宽度</div>
            {widths.map((w) => (
              <button key={w.label} onClick={() => { w.pick(); pop.close(); }} aria-pressed={w.on}
                className="w-full grid grid-cols-[16px_minmax(0,1fr)_auto] gap-1.5 items-center h-7 pl-1.5 pr-2 rounded-sm hover:bg-hover text-left">
                <Glyph d={ICON.check} size={12} stroke={1.7} className={`text-accent ${w.on ? "" : "opacity-0"}`} />
                <span className="truncate">{w.label}</span>
                <span className="font-mono text-[11px] text-muted">{w.px}</span>
              </button>
            ))}
            <div className="h-px mx-1.5 my-1 bg-border" />
          </>}
          <div className="flex items-center gap-1 pl-2 pr-1 py-1">
            <span className="flex-1 text-[11px] text-muted">缩放</span>
            <button className="w-6 h-6 grid place-items-center rounded-sm text-muted hover:bg-hover hover:text-text" onClick={() => onZoom(-1)} title="缩小（⌘−）" aria-label="缩小"><Glyph d={ICON.minus} size={12} /></button>
            <span className="w-[42px] text-center font-mono text-[11px] tabular-nums">{zoomPct}%</span>
            <button className="w-6 h-6 grid place-items-center rounded-sm text-muted hover:bg-hover hover:text-text" onClick={() => onZoom(1)} title="放大（⌘＋）" aria-label="放大"><Glyph d={ICON.plus} size={12} /></button>
            <button className="h-6 px-2 rounded-sm border border-border bg-panel text-[11px] text-text2 hover:bg-hover hover:text-text whitespace-nowrap" onClick={() => { onFit(); pop.close(); }} title="适配窗口（⌘0）">适配</button>
          </div>
          {extra && <div className="flex items-center gap-1 pl-2 pr-1 pb-1">{extra}</div>}
        </div>
      </Popover>
    </div>
  );
}

/** 文件 `⋯`：格式自己的几项 + **公共尾巴**（复制路径 / 在访达中显示 / 关闭页签）。
 *  尾巴写在这里而不是每个模块重复一遍 —— 它对所有格式都一样。 */
export function FileMore({ ctx, items }: { ctx: ViewContext; items: MenuItem[] }) {
  const pop = usePopover();
  const tail: MenuItem[] = [
    { label: "—" },
    { label: "复制路径", run: () => void navigator.clipboard?.writeText(`${ctx.project.dir}/${ctx.path}`).then(() => ctx.ui.toast("路径已复制", `${ctx.project.dir}/${ctx.path}`, "ok"), () => ctx.ui.toast("复制不了", "浏览器不让访问剪贴板", "error")) },
    { label: "在访达中显示", run: () => void ctx.host.revealInFinder(`${ctx.project.dir}/${ctx.path}`).catch((e: Error) => ctx.ui.toast("打不开", e.message, "error")) },
    { label: "—" },
    { label: "关闭页签", hint: "⌘W", run: ctx.ui.closeFile },
  ];
  const all = [...items, ...(ctx.kind === "dir" ? tail.slice(1, 4) : tail)];   // 目录不是页签，也没有「关闭页签」
  return (
    <div className="shrink-0">
      <button ref={pop.anchorRef as React.RefObject<HTMLButtonElement>} className="ib" onClick={pop.toggle} aria-expanded={pop.open} title="更多">⋯</button>
      {/* ⚠️ **这里必须是 `fixed` 浮层**（`Popover` 就是）。
          工具栏有 `overflow-hidden`（M8-18 为了防读数溢出加的），
          `absolute` 的浮层会被它整个裁掉 —— 用户报的「Markdown 的 ⋯ 弹不出来」就是这条。 */}
      <Popover pop={pop} align="end" width={224}>
        <div className="p-1">
          {all.map((mi, k) => mi.label === "—"
            ? <PopSep key={k} />
            : <PopItem key={k} label={mi.label} hint={mi.hint} danger={mi.danger}
                onPick={mi.run ? () => { pop.close(); mi.run!(); } : undefined} />)}
        </div>
      </Popover>
    </div>
  );
}

/** 工具栏那条 34px 横带的容器。模块的 `Toolbar` 填内容，工作台在尾巴上挂 `⋯`。 */
export function ToolbarBar({ children }: { children: React.ReactNode }) {
  /* `overflow-hidden` 是必须的：详情列窄下来（右栏一开就只剩 440 px）时，
     工具栏的读数会溢出去压在右栏上。**溢出不会报错，只会看起来像两块内容叠在一起** ——
     M8-18 的截图里抓到过。 */
  return <div data-ud="file-toolbar" className="h-[34px] px-1.5 flex items-center gap-2 border-b border-border bg-panel shrink-0 text-xs relative z-20 overflow-hidden">{children}</div>;
}
