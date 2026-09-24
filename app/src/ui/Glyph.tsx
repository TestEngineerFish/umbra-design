/** 和设计稿里的 `IconGlyph` 一一对应（M8-15）。
 *
 *  为什么值得有这个件：稿里每颗钮的图标都是一条 `d`，
 *  有了它就能**把稿里的 path 原样抄过来**，不用在字符图标里找近似的。
 *  参数照 IconGlyph 的：`size` 默认 14、`stroke` 默认 1.4、端点和折角都圆。
 *
 *  `viewBox` 固定 16 —— 稿里所有 path 都是按 16 画的，换了对不上。
 */
export function Glyph({ d, size = 14, stroke = 1.4, className }: { d: string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className} style={{ flex: "none" }}>
      <path d={d} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 稿里用到的 path，抄在一处，别各处手打（`ui/S11` 第七轮） */
export const ICON = {
  tree: "M2.5 3.5h4M4.5 3.5v8.5h3M4.5 7.8h3M10 7.8h3.5M10 12h3.5",
  chatLeft: "M2.5 3h11v10h-11zM6.5 3v10",
  chatBar: "M2.5 3h11v10h-11zM2.5 10.2h11",
  chatRight: "M2.5 3h11v10h-11zM9.5 3v10",
  caretDown: "M4.5 6.5L8 10l3.5-3.5",
  check: "M3.5 8.4l3 3 6-6.6",
  search: "M7.2 12a4.8 4.8 0 100-9.6 4.8 4.8 0 000 9.6zM10.8 10.8L13.5 13.5",
  /** 「铺到详情区」：把目录摊开占满右边 */
  spread: "M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9",
  pointer: "M4 2.8l8.4 4.4-3.6 1-1.8 3.4z",
  minus: "M3.2 8h9.6",
  plus: "M8 3.2v9.6M3.2 8h9.6",
} as const;
