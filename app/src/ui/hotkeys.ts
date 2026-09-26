import { installAcrossFrames } from "./frames";

/** 全局快捷键：挂到顶层 document **和每一个同源 iframe 的 document** 上（M8-29）。
 *
 *  **为什么要这么绕。** 用户报「⌘E 时灵时不灵，打开 html 格式时刚开始不行、后面又可以」。
 *  根因是键盘事件**不跨 iframe 边界**：焦点落进稿里之后，keydown 在稿自己的 document 上冒泡，
 *  顶层 document 一无所知。详见 `doc/00` §八十一（那一节还记了我从对的观测跳到错的结论那次）。
 */
type Handler = (e: KeyboardEvent) => void;

export function installHotkeys(on: Handler): () => void {
  return installAcrossFrames((doc, depth) => {
    /* ═══ 稿那一层（depth ≥ 2）要**给稿让路** ═══
       设计侧第九轮回复 §一.1：「稿是用户自己的设计，用户的稿里完全可能绑了 ⌘E、⌘B、⌘J」。
       顶层和 S2 壳是我们自己的 chrome，不让 —— 在那儿快捷键就该永远生效。
       ⚠️ 这条**对转发名单里所有键都适用**，不只 ⌘E。 */
    const guarded = depth >= 2
      ? (e: KeyboardEvent) => {
          /* ① 稿自己吃了这个键就不管（它 `preventDefault` 了 = 它认领了） */
          if (e.defaultPrevented) return;
          /* ② 焦点在稿里的输入框 / contenteditable 上也让路 ——
             用户正在打字，⌘E 很可能是编辑器的键而不是我们的。 */
          const t = e.target as HTMLElement | null;
          if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
          on(e);
        }
      : on;
    /* 冒泡阶段，**不用捕获** —— 捕获会抢在稿前面，让①那条判断永远为假 */
    doc.addEventListener("keydown", guarded);
    return () => doc.removeEventListener("keydown", guarded);
  });
}
