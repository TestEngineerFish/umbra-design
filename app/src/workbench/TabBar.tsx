import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PopItem, PopSep, Popover, usePopover } from "../ui/Popover";
import { kindOf } from "@shared/kinds";
import { draftTitle } from "../api/types";
import { dirtyStore } from "../ui/dirty";
import { Glyph } from "../ui/Glyph";
import type { IconName } from "../ui/icons";
import { PopoverAt } from "../ui/Popover";
import { closable, ordered, type Tab } from "./tabs";

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

export function TabBar({ tabs, current, busy, onPick, onOpen, onClose, onCloseMany, onPin, onKeep, onLocate, onToChat, onCopyPath, onReveal, tail }: {
  tabs: Tab[];
  current: string | null;
  /** 当前文件在忙（渲染 / 体检）：下沿那条线变 2px 流动 */
  busy?: boolean;
  /** 单击页签：切过去（不改它的态） */
  onPick: (path: string) => void;
  /** 双击页签：预览态转正 */
  onOpen: (path: string) => void;
  onClose: (path: string) => void;
  onCloseMany: (list: Tab[]) => void;
  onPin: (path: string, pinned: boolean) => void;
  /** 「保持打开」= 预览态转正，只在预览页签上出现 */
  onKeep: (path: string) => void;
  /** 在目录中显示：展开到它所在的目录、滚到它、描一圈边 */
  onLocate: (path: string) => void;
  onToChat: (path: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
  /** Tab 条**右端固定的那几颗**（第九轮：✎ 编辑栏 · ◨ 属性区 · ⋯ 这份文件）。
   *  位置固定，不跟着格式变 —— 格式变的是它们展开之后的内容。 */
  tail?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(9999);
  const morePop = usePopover();
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const dirtySnap = useSyncExternalStore(dirtyStore.subscribe, dirtyStore.snapshot);
  void dirtySnap;

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { const w = e!.contentRect.width; if (w > 0) setAvail(w); });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  /* 能塞下几个：先按 184 排，放不下就压到最窄 112，还放不下就收进「+N ▾」 */
  const list = ordered(tabs);
  const fitAll = list.length * TAB_W <= avail;
  const capacity = fitAll ? list.length : Math.max(1, Math.floor((avail - MORE_W) / TAB_MIN));
  const width = fitAll ? TAB_W : Math.max(TAB_MIN, Math.floor((avail - MORE_W) / Math.min(capacity, list.length)));

  /* **当前页签永远在可见的那几个里**（设计侧）：它被挤出去的话，
     就把它换到可见段的最后一个位置上。 */
  let shown = list.slice(0, capacity);
  const curTab = list.find((t) => t.path === current);
  if (curTab && !shown.includes(curTab)) shown = [...list.slice(0, capacity - 1), curTab];
  const hidden = list.filter((t) => !shown.includes(t));

  /** 同名文件（两个 README.md）在名字后面带上目录名，页签和下拉里都一样 */
  const label = (path: string) => {
    const base = draftTitle(path);
    const same = list.filter((x) => x.path !== path && draftTitle(x.path) === base);
    if (!same.length) return base;
    const dir = path.split("/").slice(-2, -1)[0];
    return dir ? `${base} · ${dir}` : base;
  };

  /* 36px：第九轮定的**所有模块状态栏一个值**。
     理由不只是整齐 —— 三列并排时三条状态栏的底线在同一个 y 上，
     横着看是一条线贯穿全屏；44/34/34 混用时这条线断成三截，
     用户说的「高度不一致」看到的就是这个。 */
  return (
    <div ref={box} data-ud="tabbar" className={`h-9 flex items-stretch border-b border-border bg-panel shrink-0 text-xs relative ${busy ? "busyline" : ""}`}>
      <div className="flex-1 min-w-0 flex items-stretch overflow-hidden">
        {tabs.length === 0 && <span className="px-3 self-center text-muted text-[11px]">还没打开文件 —— 从左边的目录里选一个</span>}
        {shown.map((t) => {
          const cur = t.path === current;
          const dirty = dirtyStore.has(t.path);
          return (
            <div key={t.path} data-ud="tab" data-current={cur || undefined} data-preview={t.preview || undefined} data-pinned={t.pinned || undefined}
              style={{ width: t.pinned ? Math.min(width, 150) : width, maxWidth: t.pinned ? 150 : width }}
              className={`group relative flex items-center gap-1.5 pl-3 pr-1.5 cursor-pointer select-none ${
                cur
                  ? "bg-panel border border-b-0 border-border rounded-t-md -mb-px text-text"
                  : "text-muted hover:text-text hover:bg-hover"} ${
                /* 预览态：**浅一档的颜色 + 不加粗**。不用斜体 ——
                   中文字体没有斜体，浏览器会硬斜切，很难看（设计侧特意写的）。 */
                t.preview ? "text-text2 font-normal" : cur ? "font-semibold" : ""}`}
              onClick={() => onPick(t.path)}
              onDoubleClick={() => onOpen(t.path)}
              onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, tab: t }); }}
              title={t.preview ? `${t.path}\n预览页签：下一次单击别的文件会盖掉它，双击留下` : t.path}>
              <Glyph icon={ICON_OF[kindOf(t.path)] ?? "file"} size={14}
                className={`shrink-0 ${cur && !t.preview ? "text-accent" : "text-muted"}`} />
              <span className="truncate flex-1">{label(t.path)}</span>
              <span className="w-4 h-4 shrink-0 grid place-items-center">
                {/* 固定的：关闭钮的位置换成图钉，点它 = 取消固定 */}
                {t.pinned ? (
                  <button className="ib w-4 h-4 text-accent" onClick={(e) => { e.stopPropagation(); onPin(t.path, false); }} title="取消固定">
                    <Glyph icon="pin" size={12} />
                  </button>
                ) : <>
                  {/* 未保存点**占关闭钮的位置**，hover 时变成 ×（编辑器通行的写法） */}
                  {dirty && <span className="w-1.5 h-1.5 rounded-full bg-text2 group-hover:hidden" title="改了还没落盘" />}
                  <button className={`ib w-4 h-4 ${dirty ? "hidden group-hover:grid" : "opacity-0 group-hover:opacity-100"}`}
                    onClick={(e) => { e.stopPropagation(); onClose(t.path); }} title="关闭 ⌘W">
                    <Glyph icon="close" size={12} />
                  </button>
                </>}
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
          {/* 这一个自己带滚动容器，内边距归它管 */}
          <Popover pop={morePop} align="end" width={300} pad="0">
            <div className="max-h-[60vh] overflow-auto p-1">
              {list.map((t) => (
                <button key={t.path} className={`w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-hover ${t.path === current ? "bg-accentSoft" : ""}`}
                  onClick={() => { morePop.close(); onPick(t.path); }}>
                  <span className="w-3 shrink-0 text-accent">{t.path === current ? "✓" : ""}</span>
                  <Glyph icon={ICON_OF[kindOf(t.path)] ?? "file"} size={13} className="shrink-0 text-muted" />
                  <span className={`truncate flex-1 ${t.preview ? "text-text2" : ""}`}>{label(t.path)}</span>
                  {t.pinned && <Glyph icon="pin" size={12} className="shrink-0 text-accent" />}
                  {dirtyStore.has(t.path) && <span className="w-1.5 h-1.5 rounded-full bg-text2 shrink-0" title="改了还没落盘" />}
                </button>
              ))}
              {current && tabs.length > 1 && <>
                <PopSep />
                <PopItem label="关闭其他页签" onPick={() => { morePop.close(); onCloseMany(closable(tabs, "others", current)); }} />
              </>}
            </div>
          </Popover>
        </div>
      )}
      {tail && <div className="shrink-0 flex items-center gap-0.5 px-1.5 border-l border-border">{tail}</div>}
      {ctx && <TabMenu ctx={ctx} tabs={tabs} onClose={() => setCtx(null)}
        on={{ onClose, onCloseMany, onPin, onKeep, onLocate, onToChat, onCopyPath, onReveal }} />}
    </div>
  );
}

/** 页签右键菜单（设计侧第九轮 §六.2）。
 *
 *  三个「关闭…」后面**写出真会关掉的个数** ——「点之前就知道结果」。
 *  未保存和固定的不算在内，一个都关不掉时整项置灰。
 *  这和目录右键那套「不弹确认、做完给撤销」是同一个思路：**把结果提前告诉人**。
 */
function TabMenu({ ctx, tabs, onClose, on }: {
  ctx: { x: number; y: number; tab: Tab };
  tabs: Tab[];
  onClose: () => void;
  on: {
    onClose: (p: string) => void; onCloseMany: (l: Tab[]) => void;
    onPin: (p: string, v: boolean) => void; onKeep: (p: string) => void;
    onLocate: (p: string) => void; onToChat: (p: string) => void;
    onCopyPath: (p: string) => void; onReveal: (p: string) => void;
  };
}) {
  const t = ctx.tab;
  const others = closable(tabs, "others", t.path);
  const right = closable(tabs, "right", t.path);
  const saved = closable(tabs, "saved", t.path);
  const run = (f: () => void) => () => { onClose(); f(); };
  return (
    <PopoverAt x={ctx.x} y={ctx.y} onClose={onClose} tag="tabmenu">
      <div>
        <div className="px-2.5 py-1 text-[11px] text-muted truncate" title={t.path}>{draftTitle(t.path)}</div>
        <PopItem label="关闭" hint="⌘W" onPick={run(() => on.onClose(t.path))} />
        <PopItem label="关闭其他" hint={`${others.length} 个`} onPick={others.length ? run(() => on.onCloseMany(others)) : undefined} />
        <PopItem label="关闭右侧" hint={`${right.length} 个`} onPick={right.length ? run(() => on.onCloseMany(right)) : undefined} />
        <PopItem label="关闭已保存的" hint={`${saved.length} 个`} onPick={saved.length ? run(() => on.onCloseMany(saved)) : undefined} />
        <PopSep />
        <PopItem label={t.pinned ? "取消固定" : "固定"} onPick={run(() => on.onPin(t.path, !t.pinned))} />
        {/* 「保持打开」只在预览页签上出现 —— 别的页签本来就是打开态 */}
        {t.preview && <PopItem label="保持打开" hint="双击" onPick={run(() => on.onKeep(t.path))} />}
        <PopSep />
        <PopItem label="在目录中显示" onPick={run(() => on.onLocate(t.path))} />
        <PopItem label="带进会话" onPick={run(() => on.onToChat(t.path))} />
        <PopSep />
        <PopItem label="复制路径" onPick={run(() => on.onCopyPath(t.path))} />
        <PopItem label="在访达中显示" onPick={run(() => on.onReveal(t.path))} />
      </div>
    </PopoverAt>
  );
}

/** 文件类型 → 图标名（第九轮那 56 颗里的） */
const ICON_OF: Record<string, IconName> = {
  dc: "file-dc", md: "file-md", image: "file-image", json: "file-json",
  code: "file-code", html: "file-web", other: "file", dir: "folder",
};
