import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 浮层：下拉、菜单、选择器共用这一份（M8-25）。
 *
 *  用户原话：「**需要封装下，方便统一管理操作逻辑以及显示样式**」。
 *  在这之前界面上有 7 处各写各的浮层，于是三个缺陷同时存在：
 *
 *  | 缺陷 | 根因 |
 *  | --- | --- |
 *  | 引擎下拉左边超出窗口 | 写死 `absolute right-0`，没人管窗口边界 |
 *  | 下拉开着时点别处不收起 | 那一处忘了加接外部点击的遮罩层 |
 *  | Markdown 的 `⋯` 弹不出来 | 浮层是 `absolute`，被父容器的 `overflow-hidden` 裁掉了 |
 *
 *  三条都是**同一个问题的三种长相**：每处自己实现一遍，就会各漏一样。
 *
 *  这里的做法：
 *  - **`fixed` 定位**，脱离任何 `overflow` 容器 —— 第三条从根上不会再发生
 *  - 打开时量一次触发元素的位置，**放不下就翻到另一边**
 *  - 遮罩层统一在这里，外部点击和 Esc 都关
 *
 *  ⚠️ 样式（圆角、阴影、内边距、动画时长）**等设计侧第九轮 9.4 的形制**，
 *  现在这一版是能用的临时值。到时候只改这一个文件。
 */
export interface PopoverCtl {
  open: boolean;
  toggle: () => void;
  close: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

export function usePopover(): PopoverCtl {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement>(null);
  return {
    open,
    toggle: useCallback(() => setOpen((o) => !o), []),
    close: useCallback(() => setOpen(false), []),
    anchorRef,
  };
}

/** 一个不依赖 `usePopover` 的受控版本 —— 右键菜单那种「位置跟着鼠标」的用它 */
export function PopoverAt({ x, y, onClose, width, tag, children }: {
  x: number; y: number; onClose: () => void; width?: number; tag?: string; children: React.ReactNode;
}) {
  return <Layer rect={{ left: x, top: y, right: x, bottom: y, width: 0, height: 0 }} anchor={null} onClose={onClose} width={width} align="start" tag={tag}>{children}</Layer>;
}

export function Popover({ pop, align = "end", width, tag, children }: {
  pop: PopoverCtl;
  /** 相对触发元素怎么对齐：`start` 左对齐 · `end` 右对齐 · `center` 居中 */
  align?: "start" | "end" | "center";
  width?: number;
  /** 结构标记，给回归判据用（判据要落在结构上，不落在文案上） */
  tag?: string;
  children: React.ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!pop.open) { setRect(null); return; }
    const el = pop.anchorRef.current;
    if (el) setRect(el.getBoundingClientRect());
  }, [pop.open, pop.anchorRef]);
  if (!pop.open || !rect) return null;
  return <Layer rect={rect} anchor={pop.anchorRef.current} onClose={pop.close} width={width} align={align} tag={tag}>{children}</Layer>;
}

const GAP = 4, EDGE = 8;

function Layer({ rect, anchor, onClose, width, align, tag, children }: {
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** 触发元素 —— 点它不算「点外面」，交给它自己 toggle */
  anchor: HTMLElement | null;
  onClose: () => void; width?: number; align: "start" | "end" | "center"; tag?: string; children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const b = el.getBoundingClientRect();
    /* 水平：先按 align 摆，**超出窗口就贴边** —— 引擎下拉那条缺陷就是没有这一步 */
    let left = align === "end" ? rect.right - b.width : align === "center" ? rect.left + rect.width / 2 - b.width / 2 : rect.left;
    left = Math.min(left, window.innerWidth - b.width - EDGE);
    left = Math.max(EDGE, left);
    /* 垂直：默认贴在下面，下面放不下就翻到上面；两边都放不下就贴着窗口 */
    let top = rect.bottom + GAP;
    if (top + b.height > window.innerHeight - EDGE) {
      const above = rect.top - GAP - b.height;
      top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - b.height - EDGE);
    }
    setPos({ left, top });
  }, [rect, align]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on);
  }, [onClose]);

  /* 外部点击**用 document 监听，不铺全屏遮罩**。
     铺遮罩的话它会盖在触发钮上面：用户点钮想关，点到的其实是遮罩 —— 行为碰巧也对，
     但任何自动化点击都会报「元素被遮挡」，而且浮层开着时整个界面都点不动。
     capture 阶段监听，赶在别人处理之前决定关不关。 */
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t)) return;      // 点在浮层里
      if (anchor?.contains(t)) return;           // 点触发钮：交给它 toggle，别在这儿抢着关
      onClose();
    };
    document.addEventListener("mousedown", on, true);
    document.addEventListener("contextmenu", on, true);
    return () => { document.removeEventListener("mousedown", on, true); document.removeEventListener("contextmenu", on, true); };
  }, [onClose, anchor]);

  return (
    <>
      <div ref={box} role="menu" data-ud={tag ?? "popover"}
        className="fixed z-[71] bg-panel border border-borderStrong rounded-lg shadow-2xl text-xs overflow-hidden"
        style={{
          left: pos?.left ?? -9999, top: pos?.top ?? -9999, width,
          /* 位置算出来之前先藏着 —— 不然会看到它从左上角跳过来 */
          opacity: pos ? 1 : 0,
          transition: "opacity .12s ease",
        }}
        onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>
  );
}

/** 菜单项 —— 这几处的写法本来也各不相同（高度 28 / 30、hover 底色深浅不一） */
export function PopItem({ label, hint, danger, disabled, onPick }: {
  label: string; hint?: string; danger?: boolean; disabled?: boolean; onPick?: () => void;
}) {
  return (
    <button disabled={disabled || !onPick} onClick={onPick}
      className={`w-full flex items-center gap-2 h-7 px-2.5 text-left hover:bg-hover disabled:opacity-40 disabled:cursor-default ${danger ? "text-err" : ""}`}>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="font-mono text-[11px] text-muted shrink-0">{hint}</span>}
    </button>
  );
}

export const PopSep = () => <div className="h-px mx-2 my-1 bg-border" />;
