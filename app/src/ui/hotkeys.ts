/** 全局快捷键：挂到顶层 document **和每一个同源 iframe 的 document** 上（M8-29）。
 *
 *  **为什么要这么绕。** 用户报「⌘E 时灵时不灵，打开 html 格式时刚开始不行、后面又可以」。
 *  根因是键盘事件**不跨 iframe 边界**：焦点落进稿里之后，keydown 在稿自己的 document 上冒泡，
 *  顶层 document 一无所知。而「刚开始不行、后面可以」正是这件事的典型长相 ——
 *  稿加载完把焦点抓了过去，等用户点一下目录或页签，焦点回到外壳，键就又好了。
 *
 *  ⚠️ **这里栽过一次判断**：M8-28 我量到「焦点在稿里时 keydown 到不了我们的 document」，
 *  观测是对的，但**直接跳到了结论**「得让 S2 壳 postMessage 转发」，没验中间那一步 ——
 *  这两层 iframe 其实是**同源**的（都由本地 http 托管）。同源就能直接读 `contentDocument`，
 *  往它上面挂监听即可，不用改设计侧的稿，也不用维护一张「哪些键要转发」的表。
 *
 *  ｜ 挂在哪 ｜ 什么时候需要 ｜
 *  ｜ --- ｜ --- ｜
 *  ｜ 顶层 document ｜ 焦点在目录 / 页签 / 聊天 ｜
 *  ｜ S2 嵌入壳的 document ｜ 焦点在壳的 chrome 上 ｜
 *  ｜ 稿自己的 document ｜ 焦点在稿里（点过稿里的元素之后） ｜
 *
 *  跨源的 iframe 读 `contentDocument` 会抛 —— 吞掉就行，那种情况本来也没办法。
 */
type Handler = (e: KeyboardEvent) => void;

export function installHotkeys(on: Handler): () => void {
  /* 记住挂过的 document：iframe 换稿时旧的会连同 document 一起消失，
     所以这里存的是「解绑函数」，dispose 时逐个调用，中途消失的调用也无害。 */
  const off: Array<() => void> = [];
  const wired = new Set<Document>();

  const wire = (doc: Document) => {
    if (wired.has(doc)) return;
    wired.add(doc);
    doc.addEventListener("keydown", on);
    off.push(() => { try { doc.removeEventListener("keydown", on); } catch { /* document 已随 iframe 消失 */ } });
    /* 这一层里后加的 iframe 也要补挂（换稿、切演示态都会换 iframe） */
    try {
      const mo = new MutationObserver(() => scan(doc));
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      off.push(() => mo.disconnect());
    } catch { /* documentElement 还没有 */ }
  };

  const scan = (doc: Document) => {
    for (const f of Array.from(doc.querySelectorAll("iframe"))) {
      let inner: Document | null = null;
      /* 跨源会在这里抛 SecurityError —— 吞掉，那种 iframe 本来也够不着 */
      try { inner = f.contentDocument; } catch { inner = null; }
      /* iframe 可能还没加载完（`contentDocument` 是那张空白的过渡文档）。
         挂一次 `load` 等它真正换过来再补 —— **这一步不能省**：
         用户说的「刚开始不行」就发生在这个窗口里。 */
      if (!f.dataset.udHotkey) {
        f.dataset.udHotkey = "1";
        const onLoad = () => scanAll();
        f.addEventListener("load", onLoad);
        off.push(() => { try { f.removeEventListener("load", onLoad); delete f.dataset.udHotkey; } catch { /* 节点没了 */ } });
      }
      if (!inner) continue;
      wire(inner);
      scan(inner);            // 嵌套：S2 嵌入壳里还装着稿本身
    }
  };

  const scanAll = () => { wire(document); scan(document); };
  scanAll();
  return () => { for (const f of off) f(); off.length = 0; wired.clear(); };
}
