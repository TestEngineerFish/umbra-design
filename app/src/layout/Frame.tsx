import { useRef, type ReactNode } from "react";

/** 工作台的布局骨架（M8-26）。
 *
 *  **为什么要单独抽出来**：用户的原话是「产品总是要迭代的，所以说要模块化处理，方便调整」。
 *  两轮之内布局已经改过三次形态：
 *
 *  | 轮次 | 中间怎么排 |
 *  | --- | --- |
 *  | 第六轮 | 会话 \| 目录 + 详情（目录在页签条下） |
 *  | 第八轮 | 会话 \| 目录 \| 详情，三块区域显隐归顶栏 |
 *  | 第九轮 | **目录 \| 详情 \| 聊天**，属性区进详情内部 |
 *
 *  每次都要在 `Workbench.tsx` 里翻找嵌套的 div 改顺序、改谁包着谁。
 *  抽出来之后，**改顺序 = 调 `regions` 数组的顺序**，别的不用动。
 *
 *  这里只管「几块怎么排」，**不管每块里面是什么** —— 那是各模块自己的事。
 */
export interface Region {
  id: string;
  /** 在不在。不在就整块不渲染（不是 `display:none` —— 里面的组件该卸载就卸载） */
  show: boolean;
  /** 宽度三态：
   *  - 给数字 = 固定宽
   *  - 给 `"fit"` = 宽度由内容自己决定（从属面板就是这种：面板体 300 + 图标轨 40，
   *    而且它其实是**并排的两块**，外面不能替它定一个总宽）
   *  - 不给 = `flex-1`，吃掉剩下的。一行里只该有一个不给的。 */
  width?: number | "fit";
  /** 拖边缘改宽。`edge` 指拖哪一侧 —— 左边那一列拖右缘，右边那一列拖左缘。 */
  resize?: { min: number; max: number; def: number; edge: "left" | "right"; onResize: (w: number) => void };
  /** 让位成浮层：盖在相邻内容上，不占位置（R5 第二步） */
  float?: boolean;
  /** 浮层态点外面关掉 */
  onFloatClose?: () => void;
  node: ReactNode;
}

export function Frame({ top, regions, bottom }: {
  top: ReactNode;
  /** **顺序即屏幕顺序**（从左到右）。下一轮要换位置，调这个数组就行。 */
  regions: Region[];
  /** 底栏。`spans` 说它横跨哪几个 region（按 id）——
   *  第八轮定的是只横跨中间那几块：会话的输入框要贴着窗口底部，
   *  右栏的面板要整列的高度。哪几块由调用处给，这里不替它决定。 */
  bottom?: { node: ReactNode; height: number; spans: string[] };
}) {
  const shown = regions.filter((r) => r.show);
  /* 底栏横跨的那一段必须是**连续的** —— 中间隔着一块没被 spans 包含的区域，
     底栏就没法画成一条。真出现的话按「第一个到最后一个」算，并在开发期喊一声。 */
  const spanIdx = bottom ? shown.map((r, i) => (bottom.spans.includes(r.id) ? i : -1)).filter((i) => i >= 0) : [];
  const spanFrom = spanIdx.length ? spanIdx[0]! : -1;
  const spanTo = spanIdx.length ? spanIdx[spanIdx.length - 1]! : -1;
  if (import.meta.env.DEV && spanIdx.length && spanTo - spanFrom + 1 !== spanIdx.length) {
    console.warn("[Frame] 底栏横跨的区域不连续，会画不成一条：", bottom?.spans);
  }

  const pieces: ReactNode[] = [];
  let i = 0;
  while (i < shown.length) {
    if (bottom && i === spanFrom) {
      /* 被底栏横跨的那几块包成一柱，底栏挂在柱子底下 */
      pieces.push(
        <div key="__span" className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex relative">
            {shown.slice(spanFrom, spanTo + 1).map((r) => <Col key={r.id} r={r} />)}
          </div>
          <div style={{ height: bottom.height }} className="shrink-0">{bottom.node}</div>
        </div>,
      );
      i = spanTo + 1;
      continue;
    }
    pieces.push(<Col key={shown[i]!.id} r={shown[i]!} />);
    i++;
  }

  /* 用 Fragment 而不是再包一层容器 —— 它要融进调用处那个 `h-full flex-col` 里。
     多包一层就要给那一层 `flex-1 min-h-0`，而忘了加的症状是整块高度塌成 0。 */
  return (
    <>
      {top}
      <div className="flex-1 min-h-0 flex relative">{pieces}</div>
    </>
  );
}

function Col({ r }: { r: Region }) {
  const ref = useRef<HTMLDivElement>(null);
  if (r.float) {
    return (
      <>
        <div className="absolute inset-0 z-20 bg-black/20" onMouseDown={r.onFloatClose} />
        <aside data-region={r.id} className="absolute left-0 top-0 bottom-0 z-30 bg-panel border-r border-border shadow-2xl"
          style={{ width: r.width ?? 280 }}>{r.node}</aside>
      </>
    );
  }
  const flex = r.width === undefined;
  /* 包装层是**横向**容器，不是纵向 —— 一个 region 里可能并排着好几块
     （从属面板 = 面板体 + 图标轨）。纵向的话它们会叠起来。
     里面单块的组件自己带 `flex-1 min-w-0` 撑开。 */
  return (
    <div ref={ref} data-region={r.id}
      className={`relative min-h-0 flex ${flex ? "flex-1 min-w-0" : "shrink-0"}`}
      style={typeof r.width === "number" ? { width: r.width } : undefined}>
      {r.node}
      {r.resize && <Grip r={r} />}
    </div>
  );
}

/** 拖边缘改宽；双击回默认值 */
function Grip({ r }: { r: Region }) {
  const g = r.resize!;
  return (
    <div className={`absolute top-0 ${g.edge === "right" ? "right-0" : "left-0"} w-1 h-full cursor-col-resize hover:bg-accent/30 z-10`}
      onDoubleClick={() => g.onResize(g.def)}
      onMouseDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        const w0: number = typeof r.width === "number" ? r.width : g.def;
        const dir = g.edge === "right" ? 1 : -1;
        const mv = (ev: MouseEvent) => g.onResize(Math.min(g.max, Math.max(g.min, Math.round(w0 + dir * (ev.clientX - x0)))));
        const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
        document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      }} />
  );
}
