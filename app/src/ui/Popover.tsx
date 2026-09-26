import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { installAcrossFrames } from "./frames";

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
 *  形制按设计侧第九轮 §四的原稿（`ui/S11-工作台布局壳.dc.html` 的浮层块）取真值：
 *  容器 `max-w 320` · 菜单 `min-w 200` · 内边距菜单 4、尺寸档 `10 8 8` ·
 *  菜单行 28 高 / `0 8` / `gap 16` · 选项行 `min-h 36` · 进场 `popDown|popUp 120ms`。
 *
 *  **退场按「怎么关的」分**（设计侧第九轮回复 §三）。我们原来一律直接卸载，理由是
 *  「点完就换内容的项，多活一帧会闪旧内容」—— 设计侧认了这条，但指出它只对**选中**那一种成立：
 *
 *  | 怎么关的 | 退场 |
 *  | --- | --- |
 *  | 选中了一项（⏎ 或点击） | 直接卸载，不淡出 |
 *  | Esc · 点别处 · 再点触发钮 · Tab 走出去 | 80 ms 淡出，**淡出期间不接指针** |
 *  | 开新浮层顶掉旧的 · 窗口大小变了 | 直接卸载 |
 *
 *  所以 `close()` 要带**原因**。不带的按 `dismiss`（淡出）——
 *  漏传的代价是多一次 80ms 淡出，比反过来（该淡的没淡）轻。
 */
export type CloseReason =
  /** 选中了一项：直接卸载。多活一帧会看到旧内容闪一下 */
  | "pick"
  /** Esc / 点别处 / 再点触发钮 / Tab 走出去：80ms 淡出 */
  | "dismiss"
  /** 被别的浮层顶掉、窗口变了：直接卸载 */
  | "replace";

/** 淡出时长。和进场的 120ms 不同 —— 设计侧给的就是不对称的两个数：
 *  出现要让人看清它从哪儿长出来，消失只要别是硬切。 */
const EXIT_MS = 80;
export interface PopoverCtl {
  open: boolean;
  /** 正在淡出：还在 DOM 里，但已经不接指针了 */
  exiting: boolean;
  toggle: () => void;
  close: (why?: CloseReason) => void;
  anchorRef: React.RefObject<HTMLElement>;
}

export function usePopover(): PopoverCtl {
  const [open, setOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const anchorRef = useRef<HTMLElement>(null);
  const timer = useRef<number | null>(null);
  /* 组件卸载时把定时器清掉，否则会对着已卸载的组件 setState */
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const close = useCallback((why: CloseReason = "dismiss") => {
    if (why !== "dismiss") { setOpen(false); setExiting(false); return; }
    setExiting(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setOpen(false); setExiting(false); }, EXIT_MS);
  }, []);
  return {
    open, exiting,
    /* 再点一次触发钮 = dismiss（要淡出）；打开时把上一次的淡出状态清掉 */
    toggle: useCallback(() => setOpen((o) => { if (o) { close("dismiss"); return o; } setExiting(false); return true; }), [close]),
    close,
    anchorRef,
  };
}

/** 一个不依赖 `usePopover` 的受控版本 —— 右键菜单那种「位置跟着鼠标」的用它。
 *
 *  淡出由它**自己管**：外面点掉时先淡 80ms 再回调 `onClose`（那时父组件才卸载它）；
 *  而选中一项时是父组件直接调 `onClose`，立刻卸载 —— 正好对上「选中直接卸载」那一档，
 *  不用给每个调用处加参数。 */
export function PopoverAt({ x, y, onClose, width, tag, pad, keys, children }: {
  x: number; y: number; onClose: () => void; width?: number; tag?: string; pad?: string;
  keys?: KeyMode; children: React.ReactNode;
}) {
  const [exiting, setExiting] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const dismiss = useCallback(() => {
    setExiting(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(onClose, EXIT_MS);
  }, [onClose]);
  /* 右键菜单贴着鼠标，**不留 4px 间隙**（原稿：`G = p.point ? 0 : 4`）——
     有间隙的话鼠标和菜单之间空一条，看着像没对准。 */
  return <Layer rect={{ left: x, top: y, right: x, bottom: y, width: 0, height: 0 }} anchor={null}
    onClose={dismiss} exiting={exiting} width={width} align="start" tag={tag} pad={pad} gap={0} keys={keys}>{children}</Layer>;
}

export function Popover({ pop, align = "end", width, tag, pad, keys, children }: {
  pop: PopoverCtl;
  /** 相对触发元素怎么对齐：`start` 左对齐 · `end` 右对齐 · `center` 居中 */
  align?: "start" | "end" | "center";
  width?: number;
  /** 结构标记，给回归判据用（判据要落在结构上，不落在文案上） */
  tag?: string;
  /** 内边距。菜单类不给（默认 4px）；里面是成行控件的给 `"10px 8px 8px"`（原稿的尺寸档） */
  pad?: string;
  /** 键盘怎么走，见 `KeyMode` */
  keys?: KeyMode;
  children: React.ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!pop.open) { setRect(null); return; }
    const el = pop.anchorRef.current;
    if (el) setRect(el.getBoundingClientRect());
  }, [pop.open, pop.anchorRef]);
  const dismiss = useCallback(() => pop.close("dismiss"), [pop]);
  if (!pop.open || !rect) return null;
  return <Layer rect={rect} anchor={pop.anchorRef.current} onClose={dismiss} exiting={pop.exiting}
    width={width} align={align} tag={tag} pad={pad} keys={keys}>{children}</Layer>;
}

const GAP = 4, EDGE = 8;

/** 键盘怎么走（设计侧第九轮回复 §二，三处要跟形制对齐）。
 *
 *  | 模式 | 谁用 | 为什么 |
 *  | --- | --- | --- |
 *  | `roving`（默认） | 菜单、选择器（引擎 / 会话历史） | ↑↓ 移焦点、⏎ 原生触发 |
 *  | `off` | **信息卡**（宽度 · 缩放）、**带搜索框的选择器**（转到文件） | 见下 |
 *
 *  两种 `off` 的理由不一样，都不是「不要键盘」：
 *  - **信息卡**里是数字框和滑块，**↑↓ 本来就是它们调值的键** —— 被浮层接走就调不了了
 *  - **带搜索框的**焦点不能离开输入框，不然用户接着打字打不进去。
 *    那一种由调用处自己在 input 的 `onKeyDown` 里走高亮行 + `aria-activedescendant` */
export type KeyMode = "roving" | "off";

function Layer({ rect, anchor, onClose, exiting, width, align, tag, pad, gap = GAP, keys = "roving", children }: {
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** 触发元素 —— 点它不算「点外面」，交给它自己 toggle */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** 正在淡出：不接指针、透明度归零。还在 DOM 里是为了让那 80ms 看得见 */
  exiting?: boolean;
  width?: number; align: "start" | "end" | "center"; tag?: string; pad?: string; gap?: number;
  keys?: KeyMode; children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  /* `up` 决定进场是往下展开还是往上（`popDown` / `popUp`）；
     `maxH` 只在**上下都放不下**时才给 —— 平时不限高，限了高会凭空出一条滚动条。 */
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean; maxH: number | null } | null>(null);

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const b = el.getBoundingClientRect();
    /* 水平：先按 align 摆，**超出窗口就贴边** —— 引擎下拉那条缺陷就是没有这一步 */
    let left = align === "end" ? rect.right - b.width : align === "center" ? rect.left + rect.width / 2 - b.width / 2 : rect.left;
    left = Math.min(left, window.innerWidth - b.width - EDGE);
    left = Math.max(EDGE, left);
    /* 垂直：默认贴在下面；下面放不下就翻到上面；**上下都放不下就放在大的那一边并限高滚动**
       （原稿 `placePop`）。早先这里是「贴着窗口」，浮层比窗口还高时上半截会被顶出去。 */
    let top = rect.bottom + gap, up = false, maxH: number | null = null;
    if (top + b.height > window.innerHeight - EDGE) {
      if (rect.top - gap - b.height >= EDGE) { top = rect.top - gap - b.height; up = true; }
      else {
        const below = window.innerHeight - EDGE - top, above = rect.top - gap - EDGE;
        if (above > below) { up = true; maxH = above; top = EDGE; } else maxH = below;
      }
    }
    setPos({ left, top, up, maxH });
  }, [rect, align, gap]);

  /* 键盘导航（原稿 `menuKey`：↑↓ 走项、Home/End 到头尾、Enter 执行）。
     ⚠️ 原稿自己维护一个 `popActive` 下标，因为浮层**拥有**菜单项数据；
     这一版收的是任意 children，拿不到那个列表 —— 所以改成**漫游焦点**：
     在盒子里查按钮、`.focus()` 过去，`Enter` 交给浏览器原生触发。
     换来的好处是引擎 / 历史 / 尺寸那几个非菜单浮层顺带也能键盘走。 */
  useEffect(() => {
    if (keys === "off") return;
    const on = (e: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const el = box.current; if (!el) return;
      const btns = Array.from(el.querySelectorAll<HTMLElement>("button:not([disabled]),[role=menuitem]:not([aria-disabled=true])"));
      if (!btns.length) return;
      e.preventDefault(); e.stopPropagation();
      const cur = btns.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1
        : e.key === "ArrowDown" ? (cur + 1) % btns.length : (cur - 1 + btns.length) % btns.length;
      btns[next]!.focus();
      btns[next]!.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", on, true);
    /* **悬停要跟着挪焦点**（设计侧 §二.3）：不然鼠标停在第 2 行、键盘焦点在第 4 行，
       两行同时亮 —— 违反「悬停和键盘高亮是同一个当前行」。
       用事件委托而不是给每个 `PopItem` 加 `onMouseEnter`：浮层里的行不止 `PopItem` 一种。 */
    const el = box.current;
    const enter = (e: Event) => {
      const t = (e.target as HTMLElement | null)?.closest("button:not([disabled])") as HTMLElement | null;
      if (t && el?.contains(t) && document.activeElement !== t) t.focus();
    };
    el?.addEventListener("mouseover", enter);
    return () => { document.removeEventListener("keydown", on, true); el?.removeEventListener("mouseover", enter); };
  }, [keys]);

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
    /* ⚠️ **要挂到同源 iframe 上**（设计侧 §一.2 点名要补）：
       浮层开着时在稿里右键或按下鼠标，事件在稿自己的 document 上冒泡，
       顶层收不到 —— 浮层就赖着不走。和快捷键是同一个坑（`00` §八十一）。 */
    return installAcrossFrames((doc) => {
      doc.addEventListener("mousedown", on, true);
      doc.addEventListener("contextmenu", on, true);
      return () => { doc.removeEventListener("mousedown", on, true); doc.removeEventListener("contextmenu", on, true); };
    });
  }, [onClose, anchor]);

  return (
    <>
      <div ref={box} role="menu" data-ud={tag ?? "popover"} data-up={pos?.up || undefined} data-exiting={exiting || undefined}
        className="fixed z-[71] bg-panel border border-borderStrong rounded-lg shadow-2xl text-xs overflow-x-hidden overflow-y-auto"
        style={{
          left: pos?.left ?? -9999, top: pos?.top ?? -9999,
          /* 不给 `width` 就按内容撑，但**菜单类要有 200 下限**（原稿 `popMinW`）——
             不设下限的话只有「重命名」两个字的菜单会窄成一条。 */
          width, minWidth: width ? undefined : 200, maxWidth: 320,
          maxHeight: pos?.maxH ?? undefined,
          padding: pad ?? 4,
          /* 位置算出来之前先藏着 —— 不然会看到它从左上角跳过来。
             用 `visibility` 而不是 `opacity`：`opacity: 0` 的东西还能被点到。 */
          visibility: pos ? "visible" : "hidden",
          animation: pos && !exiting ? `${pos.up ? "popUp" : "popDown"} var(--dur-fast) var(--ease)` : undefined,
          /* 淡出：80ms 归零，期间**不接指针** —— 正在消失的东西还能点到，
             用户会点到一个他以为已经没了的菜单项。 */
          ...(exiting ? { opacity: 0, pointerEvents: "none" as const, transition: `opacity ${EXIT_MS}ms linear` } : null),
        }}
        onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>
  );
}

/** 菜单项。形制取原稿：28 高 · `padding 0 8` · `gap 16` · `radius-sm` · 12px。
 *  这几处的写法本来各不相同（高度 28 / 30、内边距 8 / 10、hover 底色深浅不一）。
 *  `focus:` 和 `hover:` 给同一个底色 —— 键盘走到和鼠标停在，看起来该是一件事。 */
export function PopItem({ label, hint, danger, disabled, onPick }: {
  label: string; hint?: string; danger?: boolean; disabled?: boolean; onPick?: () => void;
}) {
  return (
    <button role="menuitem" disabled={disabled || !onPick} onClick={onPick}
      className={`w-full flex items-center gap-4 h-7 px-2 rounded-sm text-left whitespace-nowrap outline-none hover:bg-hover focus-visible:bg-hover disabled:opacity-40 disabled:cursor-default ${danger ? "text-err" : ""}`}>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="font-mono text-[11px] text-muted shrink-0">{hint}</span>}
    </button>
  );
}

/** 分隔线：`1px` · `margin 4px 6px`（原稿） */
export const PopSep = () => <div className="h-px mx-1.5 my-1 bg-border" />;

/** 浮层头：一句说明这个浮层是干什么的，`6px 8px 4px`、单行省略（原稿 `popHead`）。
 *  和 `PopGroup` 的区别是内边距上下不同 —— 头贴着浮层顶边，分组标签要和上一组隔开。 */
export const PopHead = ({ children }: { children: React.ReactNode }) =>
  <div className="px-2 pt-1.5 pb-1 text-[11px] leading-normal text-muted truncate">{children}</div>;

/** 分组标签：`8px 8px 4px`（原稿 `engineGroups` / `histGroups` 的那一行） */
export const PopGroup = ({ children }: { children: React.ReactNode }) =>
  <div className="px-2 pt-2 pb-1 text-[11px] text-muted">{children}</div>;
