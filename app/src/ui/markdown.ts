import MarkdownIt from "markdown-it";

/** 全站唯一的 Markdown 渲染器。
 *
 *  **一处配置、一处样式。** 渲染出来的 HTML 一律套 `.md-body`（样式在 index.css，也只有那一份），
 *  谁要渲染 Markdown 都从这里拿 —— 不要在别处再 `new MarkdownIt`，
 *  两个实例迟早配置不一致（一个开了 linkify 一个没开，同一段文字在两处长得不一样）。
 *
 *  `html: false` 是安全线：AI 的回复和用户的 `.md` 都算外部输入，
 *  不解析原始 HTML 就没有注入的口子。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** 整篇渲染（`.md` 文件、AI 的长回复） */
export function renderMd(src: string): string {
  return md.render(src ?? "");
}

/** 只渲染行内（不生成 <p>）—— 给一行字用，比如工具行里的说明 */
export function renderMdInline(src: string): string {
  return md.renderInline(src ?? "");
}
