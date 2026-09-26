/** `.md` 的纯解析函数。**从 `app/src/kinds/md/parse.ts` 一字不改搬过来**（M11-9b）——
 *  它不碰 React 也不碰后端，所以搬迁是逐行对照的，不是重写。
 *  正文、大纲、工具面三处都用得上，所以单放一份。 */

/** frontmatter 只认文件开头那一块 `---`；不是开头的 `---` 是分隔线，不能当它 */
export function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { front: null, body: src, bodyStartLine: 1 };
  return { front: m[1] ?? "", body: src.slice(m[0].length), bodyStartLine: src.slice(0, m[0].length).split("\n").length };
}

export function frontSummary(front) {
  return front.split("\n").filter(Boolean).slice(0, 3).map((l) => l.replace(/:\s*/, " ").trim()).join(" · ");
}

/** 标题与它在**整个文件**里的行号（frontmatter 计入 —— 和源码视图、会话药丸同一个坐标系） */
export function headings(body, offset) {
  const out = [];
  let fence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: offset + i });
  });
  return out;
}

export function diffLines(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  let changed = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) changed++;
  return changed === 1 ? "改了 1 行" : `改了 ${changed} 行`;
}

export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
