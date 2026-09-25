import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PopItem, PopSep, Popover, usePopover } from "../ui/Popover";
import { kindOf } from "@shared/kinds";
import { draftTitle } from "../api/types";
import { dirtyStore } from "../ui/dirty";

/** 页签条（M8-22 重画，形制按设计侧第八轮 §六）。
 *
 *  用户提了三件，每件背后都有一条理由：
 *
 *  **① 那颗灰点是什么？** 原来是体检状态，他读成了「未保存」。
 *  设计侧的裁决：**体检不上页签**（它已经在树、诊断角标、诊断面板三处），
 *  页签上只留**未保存**，而且**占关闭钮的位置**、颜色用 `text-2` **不用 warn 橙** ——
 *  「它表示进度，不是警告」。他会那样读，恰恰因为见过这种写法。
 *
 *  **② 太过直白。** 原来每个页签都是等大的格子、中间用竖线隔开。
 *  现在只有当前那一个有形状：panel 底色 + 三面描边 + 上圆角，
 *  下边和文件工具栏连成一片，读作「这一行工具属于这个页签」。
 *
 *  **③ 右边不该有竖滚动条。** 那是横向滚动容器带出来的。
 *  改成放不下就收进「+N ▾」，**不横向滚动，也就没有滚动条**。
 */
const TAB_W = 184, TAB_MIN = 112, MORE_W = 56;

export function TabBar({ tabs, current, onPick, onClose, onCloseOthers, tail }: {
  tabs: string[];
  current: string | null;
  onPick: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (keep: string) => void;
  /** Tab 条**右端固定的那几颗**（第九轮：✎ 编辑栏 · ◨ 属性区 · ⋯ 这份文件）。
   *  位置固定，不跟着格式变 —— 格式变的是它们展开之后的内容。 */
  tail?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(9999);
  const morePop = usePopover();
  const dirtySnap = useSyncExternalStore(dirtyStore.subscribe, dirtyStore.snapshot);
  void dirtySnap;

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { const w = e!.contentRect.width; if (w > 0) setAvail(w); });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  /* 能塞下几个：先按 184 排，放不下就压到最窄 112，还放不下就收进「+N ▾」 */
  const fitAll = tabs.length * TAB_W <= avail;
  const capacity = fitAll ? tabs.length : Math.max(1, Math.floor((avail - MORE_W) / TAB_MIN));
  const width = fitAll ? TAB_W : Math.max(TAB_MIN, Math.floor((avail - MORE_W) / Math.min(capacity, tabs.length)));

  /* **当前页签永远在可见的那几个里**（设计侧）：它被挤出去的话，
     就把它换到可见段的最后一个位置上。 */
  let shown = tabs.slice(0, capacity);
  if (current && tabs.includes(current) && !shown.includes(current)) shown = [...tabs.slice(0, capacity - 1), current];
  const hidden = tabs.filter((t) => !shown.includes(t));

  /** 同名文件（两个 README.md）在名字后面带上目录名，页签和下拉里都一样 */
  const label = (t: string) => {
    const base = draftTitle(t);
    const same = tabs.filter((x) => x !== t && draftTitle(x) === base);
    if (!same.length) return base;
    const dir = t.split("/").slice(-2, -1)[0];
    return dir ? `${base} · ${dir}` : base;
  };

  /* 36px：第九轮定的**所有模块状态栏一个值**。
     理由不只是整齐 —— 三列并排时三条状态栏的底线在同一个 y 上，
     横着看是一条线贯穿全屏；44/34/34 混用时这条线断成三截，
     用户说的「高度不一致」看到的就是这个。 */
  return (
    <div ref={box} data-ud="tabbar" className="h-9 flex items-stretch border-b border-border bg-panel shrink-0 text-xs relative">
      <div className="flex-1 min-w-0 flex items-stretch overflow-hidden">
        {tabs.length === 0 && <span className="px-3 self-center text-muted text-[11px]">还没打开文件 —— 从左边的目录里选一个</span>}
        {shown.map((t) => {
          const cur = t === current;
          const dirty = dirtyStore.has(t);
          return (
            <div key={t} data-ud="tab" data-current={cur || undefined} style={{ width, maxWidth: width }}
              className={`group relative flex items-center gap-1.5 pl-3 pr-1.5 cursor-pointer select-none ${
                cur
                  ? "bg-panel border border-b-0 border-border rounded-t-md -mb-px text-text font-semibold"
                  : "text-muted hover:text-text hover:bg-hover"}`}
              onClick={() => onPick(t)} title={t}>
              <span className={`shrink-0 text-[13px] ${cur ? "text-accent" : "text-muted"}`}>{ICONS[kindOf(t)] ?? "▢"}</span>
              <span className="truncate flex-1">{label(t)}</span>
              {/* 未保存点**占关闭钮的位置**，hover 时变成 ×（编辑器通行的写法） */}
              <span className="w-4 h-4 shrink-0 grid place-items-center">
                {dirty && <span className="w-1.5 h-1.5 rounded-full bg-text2 group-hover:hidden" title="改了还没落盘" />}
                <button className={`ib w-4 h-4 text-[10px] ${dirty ? "hidden group-hover:grid" : "opacity-0 group-hover:opacity-100"}`}
                  onClick={(e) => { e.stopPropagation(); onClose(t); }} title="关闭">×</button>
              </span>
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <div className="shrink-0 flex">
          <button data-ud="tab-more" ref={morePop.anchorRef as React.RefObject<HTMLButtonElement>}
            className={`px-2.5 border-l border-border whitespace-nowrap ${morePop.open ? "bg-hover text-text" : "text-muted hover:text-text"}`}
            onClick={morePop.toggle} aria-expanded={morePop.open} title="所有打开的文件">+{hidden.length} ▾</button>
          <Popover pop={morePop} align="end" width={300}>
            <div className="max-h-[60vh] overflow-auto py-1">
              {tabs.map((t) => (
                <button key={t} className={`w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-hover ${t === current ? "bg-accentSoft" : ""}`}
                  onClick={() => { morePop.close(); onPick(t); }}>
                  <span className="w-3 shrink-0 text-accent">{t === current ? "✓" : ""}</span>
                  <span className="shrink-0 text-muted">{ICONS[kindOf(t)] ?? "▢"}</span>
                  <span className="truncate flex-1">{label(t)}</span>
                  {dirtyStore.has(t) && <span className="w-1.5 h-1.5 rounded-full bg-text2 shrink-0" title="改了还没落盘" />}
                </button>
              ))}
              {current && tabs.length > 1 && <>
                <PopSep />
                <PopItem label="关闭其他页签" onPick={() => { morePop.close(); onCloseOthers(current); }} />
              </>}
            </div>
          </Popover>
        </div>
      )}
      {tail && <div className="shrink-0 flex items-center gap-0.5 px-1.5 border-l border-border">{tail}</div>}
    </div>
  );
}

const ICONS: Record<string, string> = { dc: "◧", md: "≡", image: "▣", json: "{}", code: "⟨⟩", html: "◻", other: "▢", dir: "▤" };
