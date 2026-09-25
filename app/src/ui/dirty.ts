/** 哪几份文件「改了还没落盘」（M8-22）。
 *
 *  页签上那颗点要的就是这个。**为什么要一个全局登记处**：
 *  未保存是**每种格式各自知道**的事（Markdown 看文本和盘上的差异，设计稿看壳报上来的状态），
 *  而要显示它的地方在页签条 —— 那儿不属于任何一种格式。
 *
 *  ⚠️ 这里只记「进度」，不记「质量」。体检状态是另一回事，它在树、诊断角标、诊断面板三处，
 *  **不上页签**（设计侧第八轮 §六：页签是「开着哪几份」，不是「这几份怎么样」）。
 */
const set = new Set<string>();
const subs = new Set<() => void>();

export const dirtyStore = {
  subscribe(f: () => void): () => void { subs.add(f); return () => subs.delete(f); },
  /** 给 `useSyncExternalStore` 用的快照：内容变了这个串就变 */
  snapshot(): string { return [...set].sort().join("|"); },
  has(path: string): boolean { return set.has(path); },
  set(path: string, dirty: boolean): void {
    const had = set.has(path);
    if (dirty === had) return;
    if (dirty) set.add(path); else set.delete(path);
    for (const f of subs) f();
  },
  /** 关掉页签时清掉，免得一个已经不在的文件永远挂着点 */
  drop(path: string): void { if (set.delete(path)) for (const f of subs) f(); },
};
