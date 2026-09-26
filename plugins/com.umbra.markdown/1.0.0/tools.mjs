/** Markdown 插件的工具面（B 面）—— 给大模型调用的编辑能力。
 *
 *  这一面是 `.md` 以前**没有**的：以前 AI 只能对 `.md` 做整文件读写，
 *  要改一节标题下的内容得把整篇读进上下文、改完整篇写回去。
 *  有了结构化的能力，改一节就只动一节。
 *
 *  ⚠️ 写盘**必须走宿主的 `write_file`**（纪律① 唯一写入口）：
 *  快照、变更清单、一键回退都挂在那条路上，绕过去的话「AI 改错了能退回来」就没了 ——
 *  而那正是用户敢让 AI 动自己文件的前提。
 */
export default function register(host) {
  const readText = async (path) => {
    const r = await host.call("read_file", { path });
    if (!r.ok) throw new Error(r.errors?.[0]?.message ?? "读不到");
    return { text: r.data.content ?? "", sha: r.data.sha256 };
  };
  const sections = (text) => {
    const lines = text.split("\n");
    const out = []; let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
      if (fence) return;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ level: m[1].length, title: m[2], line: i + 1 });
    });
    return out.map((h, i) => ({ ...h, endLine: i + 1 < out.length ? out[i + 1].line - 1 : lines.length }));
  };

  host.defineCap({
    name: "com.umbra.markdown.outline",
    title: "列出一份 Markdown 的章节",
    summary: "返回每个标题的层级、文字、起止行号。改某一节之前先用它定位 —— 比把整篇读进来省得多。",
    input: { path: "string" },
    async run({ path }) {
      const { text } = await readText(path);
      return { path, sections: sections(text) };
    },
  });

  host.defineCap({
    name: "com.umbra.markdown.replace_section",
    title: "替换 Markdown 的某一节",
    summary: "按标题文字找到那一节，用新内容替换它的正文（标题行保留）。只动这一节，别处一个字不改。",
    input: { path: "string", title: "string", content: "string" },
    async run({ path, title, content }) {
      const { text, sha } = await readText(path);
      const secs = sections(text);
      const s = secs.find((x) => x.title === title);
      if (!s) return { ok: false, why: `没有叫「${title}」的章节`, have: secs.map((x) => x.title) };
      const lines = text.split("\n");
      const next = [...lines.slice(0, s.line), ...String(content).split("\n"), ...lines.slice(s.endLine)];
      const w = await host.call("write_file", { path, content: next.join("\n"), expectSha256: sha, note: `替换章节「${title}」` });
      if (!w.ok) return { ok: false, why: w.errors?.[0]?.message ?? "写不进去" };
      return { ok: true, snapshot: w.data.snapshot, replacedLines: s.endLine - s.line };
    },
  });
}
