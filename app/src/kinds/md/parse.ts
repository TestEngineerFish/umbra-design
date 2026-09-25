/** `.md` 的纯解析函数（M8-15b 从 `workbench/MarkdownView.tsx` 搬来，一个字没改）。
 *  拿出来单放是因为它们**不碰 React 也不碰后端** —— 视图、工具栏、大纲都用得上，
 *  而且这一层出错最容易写进回归基准。 */

export interface Outline { level: number; text: string; line: number }

/** frontmatter 只认文件开头那一块 `---`；不是开头的 `---` 是分隔线，不能当它 */
export function splitFrontmatter(src: string): { front: string | null; body: string; bodyStartLine: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { front: null, body: src, bodyStartLine: 1 };
  return { front: m[1] ?? "", body: src.slice(m[0].length), bodyStartLine: src.slice(0, m[0].length).split("\n").length };
}

export function frontSummary(front: string): string {
  return front.split("\n").filter(Boolean).slice(0, 3).map((l) => l.replace(/:\s*/, " ").trim()).join(" · ");
}

/** 标题与它在**整个文件**里的行号（frontmatter 计入 —— 和源码视图、会话药丸同一个坐标系） */
export function headings(body: string, offset: number): Outline[] {
  const out: Outline[] = [];
  let fence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: offset + i });
  });
  return out;
}

export function diffLines(a: string, b: string): string {
  const x = a.split("\n"), y = b.split("\n");
  let changed = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) changed++;
  return changed === 1 ? "改了 1 行" : `改了 ${changed} 行`;
}

export function jumpTo(h: Outline, mode: "render" | "source", area: React.RefObject<HTMLTextAreaElement>, setMode: (m: "render" | "source") => void): void {
  if (mode === "source" && area.current) {
    const el = area.current;
    const pos = el.value.split("\n").slice(0, h.line - 1).join("\n").length + 1;
    el.focus(); el.setSelectionRange(pos, pos);
    el.scrollTop = Math.max(0, (h.line - 3) * 24);
    return;
  }
  // 渲染视图：按标题文字找对应的 h1..h6
  const body = document.querySelector(".md-body");
  const hit = body ? Array.from(body.querySelectorAll("h1,h2,h3,h4,h5,h6")).find((e) => e.textContent?.trim() === h.text) : null;
  if (hit) hit.scrollIntoView({ block: "start", behavior: "smooth" });
  else setMode("source");
}
