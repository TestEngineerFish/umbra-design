/** 把同一个监听挂到**顶层 document 和每一个同源 iframe 的 document** 上（M8-30 抽出）。
 *
 *  这件事有两个用户，所以从 `hotkeys.ts` 里抽了出来：
 *
 *  | 谁 | 为什么需要 |
 *  | --- | --- |
 *  | 快捷键（`hotkeys.ts`） | 键盘事件不跨 iframe 边界，焦点在稿里就够不着（`00` §八十一） |
 *  | 浮层收起（`Popover.tsx`） | 浮层开着时在稿里右键，应该关旧的开新的 —— 设计侧第九轮回复 §一.2 点名要补 |
 *
 *  `bind` 对每个够得着的 document 调一次，返回解绑函数。`depth` 是嵌套层数：
 *  0 = 顶层 · 1 = S2 嵌入壳 · ≥2 = 稿本身。**有些规矩只对稿那一层生效**
 *  （比如快捷键要给稿让路），所以这个数字要传出去。
 */
export function installAcrossFrames(
  bind: (doc: Document, depth: number) => void | (() => void),
): () => void {
  const off: Array<() => void> = [];
  const wired = new Set<Document>();

  const wire = (doc: Document, depth: number) => {
    if (wired.has(doc)) return;
    wired.add(doc);
    const un = bind(doc, depth);
    if (un) off.push(() => { try { un(); } catch { /* document 已随 iframe 消失 */ } });
    /* 这一层里后加的 iframe 要补挂（换稿、切演示态都会换掉 iframe 元素） */
    try {
      const mo = new MutationObserver(() => scan(doc, depth));
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      off.push(() => mo.disconnect());
    } catch { /* documentElement 还没有 */ }
  };

  const scan = (doc: Document, depth: number) => {
    for (const f of Array.from(doc.querySelectorAll("iframe"))) {
      let inner: Document | null = null;
      /* 跨源会在这里抛 SecurityError —— 吞掉。
         **不吞的话整个安装过程中断**，连顶层那一份都挂不上。 */
      try { inner = f.contentDocument; } catch { inner = null; }
      /* iframe 可能还没加载完（`contentDocument` 是那张空白过渡文档）。
         挂一次 `load` 等它真换过来再补 —— **这一步不能省**：
         用户报的「刚开始不行、后面又可以」就发生在这个窗口里。 */
      if (!f.dataset.udFrames) {
        f.dataset.udFrames = "1";
        const onLoad = () => scanAll();
        f.addEventListener("load", onLoad);
        off.push(() => { try { f.removeEventListener("load", onLoad); delete f.dataset.udFrames; } catch { /* 节点没了 */ } });
      }
      if (!inner) continue;
      wire(inner, depth + 1);
      scan(inner, depth + 1);      // 嵌套：S2 嵌入壳里还装着稿本身
    }
  };

  const scanAll = () => { wire(document, 0); scan(document, 0); };
  scanAll();
  return () => { for (const f of off) f(); off.length = 0; wired.clear(); };
}
