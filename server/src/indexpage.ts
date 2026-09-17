/** build_index —— 生成项目入口页。doc/08 S1 的数据契约 + doc/01 §4.2 形态 A
 *
 * 产出三样：
 *   .umbradesign/index-data.json   数据（08 S1 的形状，原样）
 *   index-data.js                  同一份数据挂成 window.__UD_INDEX，给别的页/脚本用
 *                                  （入口页本身不读它，数据是内联注进去的，见 injectIndexData）
 *   _ds-tool/tokens.css            工具皮肤，拷成与设计稿里 href 相同的相对路径
 *   index.dc.html                  入口页本身，用 .dc.html 写（自举）
 *
 * index.dc.html 优先用设计侧那份 `ui/S1-稿件索引.dc.html`（它读
 * `window.__UD_INDEX`：有真实数据就显示真实数据，没有就退回自带的 9 个演示态，
 * 所以设计评审和线上入口是同一份文件，不会分叉）。
 * 下面 page() 生成的过渡页只在设计稿缺失时兜底 —— 打包缺文件也还有个能用的入口。
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { TOOL_ROOT, listDrafts, type Project } from "./project.js";
import { parseDraft } from "./draft.js";
import { validateDraft } from "./validate.js";
import { ensureRuntimeBeside, prepareForDisk, writeAtomic } from "./normalize.js";
import { listVersions } from "./history.js";

export type Health = "ok" | "warn" | "error" | "unchecked";

export interface IndexDraft {
  file: string;
  title: string;
  kind: "page" | "component";
  elements: number;
  version: string | null;
  updatedAt: string;
  thumb: string | null;
  health: Health;
  diagnostics: { errors: number; warnings: number };
  renderMs: number | null;
  nodeCount: number | null;
  states: string[];
  imports: string[];
  importedBy: string[];
}

export interface IndexData {
  project: {
    name: string; title: string; draftCount: number; generatedAt: string;
    /** 阈值给页面用：S1 的「接近上限 / 已超限」文案跟着租户配置走，不写死 */
    limits: { elementsWarn: number; elementsHard: number };
  };
  drafts: IndexDraft[];
}

const rel = (p: Project, abs: string) => relative(p.dir, abs).split(sep).join("/");

/** 页稿还是组件稿。
 *
 * 原来按「有没有 props」判 —— 实测在真项目上错得很明显：《Umbra PC 端》引了
 * 115 个子组件、6,323 个元素，只因为带 props 就被标成「组件稿」。props 上挂的
 * 其实是演示态（`kind` 枚举），跟是不是组件无关。helmet 也不行：57 份稿全都有。
 *
 * 改成按 import 图判，三条规则，没有魔法阈值：
 *   1. 被别的稿引用  → 组件稿（这是结构事实，最硬）
 *   2. 引用了别的稿  → 页稿（它是一棵组合树的顶）
 *   3. 都没有（孤立）→ 退回看 props
 *
 * 已知边界：还没被任何稿引用的新组件会先显示成页稿，等它被引用就自己纠正。
 */
function classifyKind(row: IndexDraft, hasProps: boolean): "page" | "component" {
  if (row.importedBy.length) return "component";
  if (row.imports.length) return "page";
  return hasProps ? "component" : "page";
}

export async function collectIndex(p: Project): Promise<IndexData> {
  const files = await listDrafts(p);
  const rows: IndexDraft[] = [];
  const importMap = new Map<string, string[]>();     // 被引者 → 引用它的稿
  const hasProps = new Map<string, boolean>();       // 稿 → 有没有非 $ 前缀的 props

  for (const abs of files) {
    const r = rel(p, abs);
    if (r === "index.dc.html") continue;             // 入口页自己不进清单
    const src = await readFile(abs, "utf8");
    const d = parseDraft(src, r);
    const v = await validateDraft(p, r, src, r);
    const errors = v.diags.filter((x) => x.level === "error").length;
    const warnings = v.diags.filter((x) => x.level === "warning").length;
    const versions = await listVersions(p, r);

    // 缩略图：render_check 存的那个命名
    const shot = `.umbradesign/shots/${r.replace(/[\\/]/g, "__").replace(/\.dc\.html$/, "")}@1440x900.png`;
    const hasShot = existsSync(join(p.dir, shot));

    // 演示态：props 里 kind 的 options，或 sc-if 的条件名
    const states: string[] = [];
    const kindProp = (d.props?.kind ?? null) as { options?: unknown[] } | null;
    if (Array.isArray(kindProp?.options)) states.push(...(kindProp.options as unknown[]).map(String));
    else for (const b of d.branches) if (b.cond) states.push(b.cond);

    hasProps.set(r, Object.keys(d.props ?? {}).some((k) => !k.startsWith("$")));

    const imports = d.imports.map((im) => im.name).filter(Boolean);
    for (const im of imports) {
      const key = basename(im);
      importMap.set(key, [...(importMap.get(key) ?? []), r]);
    }

    rows.push({
      file: r,
      title: basename(r).replace(/\.dc\.html$/, ""),
      kind: "page",                                  // 先占位，下面按 import 图定（见 classifyKind）
      elements: d.elements,
      version: versions.length ? (versions[versions.length - 1] as string) : null,
      updatedAt: (await stat(abs)).mtime.toISOString(),
      thumb: hasShot ? shot : null,
      health: errors ? "error" : !hasShot ? "unchecked" : warnings ? "warn" : "ok",
      diagnostics: { errors, warnings },
      renderMs: null,
      nodeCount: null,
      states: [...new Set(states)].slice(0, 12),
      imports,
      importedBy: [],
    });
  }

  for (const row of rows) {
    row.importedBy = [...new Set(importMap.get(row.title) ?? [])].filter((f) => f !== row.file);
    row.kind = classifyKind(row, hasProps.get(row.file) === true);
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    project: {
      name: p.name, title: p.title, draftCount: rows.length,
      generatedAt: new Date().toISOString(), limits: p.limits,
    },
    drafts: rows,
  };
}

// ───────────────────────── 入口页模板 ─────────────────────────

const HEALTH_LABEL: Record<Health, string> = { ok: "通过", warn: "有提醒", error: "有错误", unchecked: "未体检" };

/** ⚠️ token 只有三档：--tool-<sem> / -soft / -border，没有 -text 与 -on-<sem>。
 *  设计侧把 base 兼作「平底上的字」，实测对比度成立（浅色 4.67–6.92，深色 6.14–7.71，
 *  最紧的是浅色 ok on ok-soft = 4.67）。所以这里用 base 当字色，不要去引不存在的 -text。
 *  改 token 时先复算这一组，别把 4.67 那一档调得更浅。 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(data: IndexData): string {
  const j = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const t = (k: string) => `var(--tool-${k})`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./_ds-tool/tokens.css">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${t("bg")};color:${t("text")};font-family:${t("sans")};
       -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
  a{color:inherit;text-decoration:none}
  [data-f]:focus-visible{outline:2px solid ${t("accent")};outline-offset:2px;border-radius:6px}
</style>
</helmet>
<div style="min-height:100vh">
  <header style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid ${t("border")};background:${t("panel")}">
    <strong style="font-size:14px">UmbraDesign</strong>
    <span style="color:${t("border-strong")}">|</span>
    <strong style="font-size:14px">{{ title }}</strong>
    <code style="font-family:${t("mono")};font-size:12px;color:${t("muted")}">{{ name }}</code>
    <span style="color:${t("muted")};font-size:12px">· {{ countLabel }}</span>
    <span style="flex:1"></span>
    <span style="font-size:12px;color:${t("muted")}">{{ generatedLabel }}</span>
  </header>

  <div style="padding:14px 20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <input data-f="1" value="{{ q }}" onInput="{{ onQuery }}" placeholder="搜稿名、文件名、演示态…"
      style="flex:1;min-width:220px;padding:8px 12px;border:1px solid ${t("border")};border-radius:8px;
             background:${t("panel")};color:${t("text")};font-size:13px;font-family:inherit">
    <sc-for list="{{ filters }}" as="f">
      <button data-f="1" onClick="{{ f.pick }}" style="{{ f.style }}">{{ f.label }}</button>
    </sc-for>
  </div>

  <sc-if value="{{ empty }}">
    <div style="padding:80px 20px;text-align:center;color:${t("muted")}">
      <div style="font-size:16px;color:${t("text")};font-weight:600;margin-bottom:8px">{{ emptyTitle }}</div>
      <div style="font-size:13px;line-height:1.8">{{ emptyBody }}</div>
    </div>
  </sc-if>

  <sc-if value="{{ hasRows }}">
  <div style="padding:0 20px 40px">
    <div style="background:${t("panel")};border:1px solid ${t("border")};border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 84px 80px 76px 96px 132px;gap:10px;
                  padding:9px 14px;background:${t("panel-2")};color:${t("muted")};font-size:12px">
        <span>稿件</span><span>类型</span><span style="text-align:right">元素</span>
        <span>版本</span><span>更新</span><span>健康</span>
      </div>
      <sc-for list="{{ rows }}" as="r">
        <div style="display:grid;grid-template-columns:1fr 84px 80px 76px 96px 132px;gap:10px;
                    padding:9px 14px;border-top:1px solid ${t("border")};align-items:baseline;font-size:13px">
          <span>
            <a data-f="1" href="{{ r.href }}" style="font-weight:600">{{ r.title }}</a>
            <span style="color:${t("muted")};font-size:12px"> {{ r.statesLabel }}</span>
            <span style="display:block;font-family:${t("mono")};font-size:11px;color:${t("muted")};margin-top:2px">{{ r.file }}</span>
          </span>
          <span style="color:${t("muted")};font-size:12px">{{ r.kindLabel }}</span>
          <span style="text-align:right;font-family:${t("mono")};font-size:12px">{{ r.elements }}</span>
          <span style="font-family:${t("mono")};font-size:12px;color:${t("muted")}">{{ r.versionLabel }}</span>
          <span style="color:${t("muted")};font-size:12px">{{ r.updatedLabel }}</span>
          <span><span style="{{ r.healthStyle }}">{{ r.healthLabel }}</span><span style="color:${t("muted")};font-size:11px"> {{ r.diagLabel }}</span></span>
        </div>
      </sc-for>
    </div>
    <div style="margin-top:10px;font-size:11px;color:${t("muted")}">
      这是 build_index 的兜底入口页。正常情况下用的是设计侧 ui/S1-稿件索引.dc.html —— 会走到这里说明那份稿找不到。
    </div>
  </div>
  </sc-if>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script>
const DATA = (typeof window !== 'undefined' && window.__UD_INDEX) || ${j};
const PILL = 'padding:6px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit;border:1px solid ';
const HS = {
  ok:    'padding:2px 8px;border-radius:999px;font-size:11px;background:${t("ok-soft")};color:${t("ok")}',
  warn:  'padding:2px 8px;border-radius:999px;font-size:11px;background:${t("warn-soft")};color:${t("warn")}',
  error: 'padding:2px 8px;border-radius:999px;font-size:11px;background:${t("err-soft")};color:${t("err")}',
  unchecked: 'padding:2px 8px;border-radius:999px;font-size:11px;background:${t("panel-3")};color:${t("muted")}'
};
const HL = ${JSON.stringify(HEALTH_LABEL)};
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'page', label: '页稿' },
  { key: 'component', label: '组件稿' },
  { key: 'error', label: '有错误' },
  { key: 'warn', label: '有提醒' },
  { key: 'unchecked', label: '未体检' }
];

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

class Component extends DCLogic {
  state = { q: '', filter: 'all' };

  renderVals() {
    const s = this.state;
    const q = s.q.trim().toLowerCase();
    let rows = DATA.drafts.filter(function (d) {
      if (s.filter === 'page' || s.filter === 'component') { if (d.kind !== s.filter) return false; }
      else if (s.filter === 'error' && d.diagnostics.errors === 0) return false;
      else if (s.filter === 'warn' && d.diagnostics.warnings === 0) return false;
      else if (s.filter === 'unchecked' && d.health !== 'unchecked') return false;
      if (!q) return true;
      return (d.title + ' ' + d.file + ' ' + d.states.join(' ')).toLowerCase().indexOf(q) >= 0;
    });

    const self = this;
    return {
      title: DATA.project.title,
      name: DATA.project.name,
      countLabel: DATA.project.draftCount + ' 份稿',
      generatedLabel: '索引生成于 ' + ago(DATA.project.generatedAt),
      q: s.q,
      onQuery: function (e) { self.setState({ q: e && e.target ? e.target.value : '' }); },
      filters: FILTERS.map(function (f) {
        const on = s.filter === f.key;
        return {
          label: f.label,
          pick: function () { self.setState({ filter: f.key }); },
          style: PILL + (on ? '${t("accent")};background:${t("accent-soft")};color:${t("accent")}'
                            : '${t("border")};background:${t("panel")};color:${t("text-2")}')
        };
      }),
      empty: rows.length === 0,
      emptyTitle: DATA.project.draftCount === 0 ? '这个项目还没有稿' : '没有匹配的稿',
      emptyBody: DATA.project.draftCount === 0
        ? '索引是扫目录扫出来的。让模型调 write_draft 写第一份 .dc.html，这一屏就会自己长出来。'
        : '换个关键词，或把筛选切回「全部」。',
      hasRows: rows.length > 0,
      rows: rows.map(function (d) {
        return {
          title: d.title,
          file: d.file,
          href: './' + d.file.split('/').map(encodeURIComponent).join('/'),
          kindLabel: d.kind === 'component' ? '组件稿' : '页稿',
          elements: String(d.elements),
          versionLabel: d.version || '—',
          updatedLabel: ago(d.updatedAt),
          statesLabel: d.states.length ? d.states.length + ' 态' : '',
          healthLabel: HL[d.health] || d.health,
          healthStyle: HS[d.health] || HS.unchecked,
          diagLabel: (d.diagnostics.errors ? d.diagnostics.errors + 'E ' : '')
                   + (d.diagnostics.warnings ? d.diagnostics.warnings + 'W' : '')
        };
      })
    };
  }
}
</script>
</body>
</html>
`;
}

export interface BuildIndexResult {
  dataFile: string;
  jsFile: string;
  indexFile: string;
  tokensFile: string | null;
  drafts: number;
  byHealth: Record<Health, number>;
  runtimeCopied: string[];
  url: string | null;
  /** 入口页用的是设计稿还是内置过渡页 */
  indexSource: string;
  /** 落盘前做了哪几步确定性改写（与 write_draft 同一条路） */
  steps: string[];
}

const DATA_OPEN = "<!-- umbradesign:index-data -->";
const DATA_CLOSE = "<!-- /umbradesign:index-data -->";

/** 把索引数据作为内联脚本注入 <head>，挂成 window.__UD_INDEX。
 *
 * 为什么不用 `<script src="./index-data.js">`：设计稿在 ui/ 下直接打开时那个文件
 * 不存在，会留一个 404 和一条控制台 error。控制台必须干净，否则 render_check
 * 每次都带噪声（doc/04 §二）。注入零额外请求，两种用法都干净。
 *
 * 幂等：标记之间的内容整段替换，重复 build_index 不会越堆越长。
 */
export function injectIndexData(src: string, data: IndexData): string {
  const block = `${DATA_OPEN}\n<script>window.__UD_INDEX = ${JSON.stringify(data)};</script>\n${DATA_CLOSE}`;
  const i = src.indexOf(DATA_OPEN);
  if (i >= 0) {
    const j = src.indexOf(DATA_CLOSE, i);
    if (j < 0) throw new Error("index-data 注入标记只有开头没有结尾，文件被手改过");
    return src.slice(0, i) + block + src.slice(j + DATA_CLOSE.length);
  }
  const head = /<head[^>]*>/i.exec(src);
  if (!head) throw new Error("入口页没有 <head>，注入不了索引数据");
  const at = head.index + head[0].length;
  return src.slice(0, at) + "\n" + block + src.slice(at);
}

export async function buildIndex(p: Project, serveUrl: string | null): Promise<BuildIndexResult> {
  const data = await collectIndex(p);
  const udDir = join(p.dir, ".umbradesign");
  await mkdir(udDir, { recursive: true });

  const dataFile = join(udDir, "index-data.json");
  await writeFile(dataFile, JSON.stringify(data, null, 1) + "\n", "utf8");

  const jsFile = join(p.dir, "index-data.js");
  await writeAtomic(jsFile, `/* 由 build_index 生成，勿手改 */\nwindow.__UD_INDEX = ${JSON.stringify(data)};\n`);

  // 工具皮肤 token：拷到**与设计稿里 href 相同的相对路径**（./_ds-tool/tokens.css）。
  // 这样 ui/ 下直接打开和当入口页用是同一个 href —— 不改写路径，也不留 404。
  let tokensFile: string | null = null;
  const srcTokens = join(TOOL_ROOT, "ui", "_ds-tool", "tokens.css");
  if (existsSync(srcTokens)) {
    const dstDir = join(p.dir, "_ds-tool");
    await mkdir(dstDir, { recursive: true });
    const dst = join(dstDir, "tokens.css");
    await copyFile(srcTokens, dst);
    tokensFile = rel(p, dst);
  }

  // 入口页：设计侧那份优先，缺了才用 page() 兜底
  const designed = join(TOOL_ROOT, "ui", "S1-稿件索引.dc.html");
  const useDesigned = existsSync(designed);
  const source = useDesigned ? "设计侧 ui/S1-稿件索引.dc.html" : "工具内置过渡页";
  const raw = injectIndexData(useDesigned ? await readFile(designed, "utf8") : page(data), data);

  // ⚠️ 必须走 prepareForDisk，和 write_draft 同一条路 —— 否则入口页没有
  // __resources 注入，断网直接白屏。验证时实测踩到了：直接 writeAtomic 写出来的页
  // 去 unpkg 取 React，被拦之后 `[dc] failed to load React or boot`。
  // 「唯一写入口」这条规矩管的就是这个，工具自己产的文件也不例外。
  const indexFile = join(p.dir, "index.dc.html");
  const prep = prepareForDisk(p, raw);
  await writeAtomic(indexFile, prep.content);
  prep.steps.push("注入 window.__UD_INDEX 索引数据");
  const runtimeCopied = await ensureRuntimeBeside(indexFile);

  const byHealth: Record<Health, number> = { ok: 0, warn: 0, error: 0, unchecked: 0 };
  for (const d of data.drafts) byHealth[d.health]++;

  return {
    dataFile: rel(p, dataFile),
    jsFile: rel(p, jsFile),
    indexFile: rel(p, indexFile),
    tokensFile,
    drafts: data.drafts.length,
    byHealth,
    runtimeCopied,
    url: serveUrl,
    indexSource: source,
    steps: prep.steps,
  };
}

export { esc };
