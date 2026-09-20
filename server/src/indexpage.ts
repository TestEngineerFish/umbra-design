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
import { serveOf } from "./serve.js";
import { readCheck, sha256, type CheckRecord } from "./check.js";
import { renderCheck } from "./render.js";

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
  /** 上次体检时间；null = 没体检过 */
  checkedAt: string | null;
  /** 体检读数是否已过期（体检之后稿又改过） */
  stale: boolean;
  /** health 是怎么来的，一句话 —— 页面拿它当 tooltip，人不用猜 */
  healthWhy: string;
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

/** 健康怎么判。
 *
 * 原来是「有 error → 红；没截图 → 未体检；有 warning → 黄；否则绿」。
 * 那个判据有个静默失败：**截图不随稿改动失效**，改完稿不重新体检，索引上仍然
 * 显示「通过」。现在读 `.umbradesign/checks/` 里的体检记录，并用 srcSha256
 * 比对源码 —— 对不上就是过期，等同于没体检。宁可说不知道，不可以说通过。
 *
 * 另外两条也是这次才对上的：
 *  - 体检没画出来（alive=false）→ 红，不管静态校验多干净。渲染是唯一验收证据（04 §二）
 *  - 断网时有被拦的外部请求、或渲染后还留着洞 → 黄，静态校验看不到这些
 */
function judgeHealth(
  errors: number, warnings: number, chk: CheckRecord | null, stale: boolean
): { health: Health; why: string } {
  if (errors) return { health: "error", why: `${errors} 条 error 级诊断，落盘会被拒` };
  if (chk && !chk.alive) return { health: "error", why: "体检时页面没画出来（1+1 都算不出）" };
  if (!chk) return { health: "unchecked", why: "还没跑过 render_check" };
  if (stale) return { health: "unchecked", why: "体检之后稿又改过，这份读数已过期" };

  const c = chk.counts;
  if (c.unresolvedHoles) return { health: "warn", why: `渲染后还留着 ${c.unresolvedHoles} 个未解析的洞` };
  if (chk.offline && c.externalRequests) return { health: "warn", why: `断网体检时有 ${c.externalRequests} 个外部请求被拦下` };
  if (c.missingResources) return { health: "warn", why: `${c.missingResources} 个资源取不到` };
  if (warnings) return { health: "warn", why: `${warnings} 条 warning 级诊断` };
  if (c.consoleWarnings) return { health: "warn", why: `控制台有 ${c.consoleWarnings} 条告警` };
  return { health: "ok", why: "静态校验干净，体检画得出来，断网无外部请求" };
}

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
    if (isToolPage(r)) continue;                     // 工具自己的页面不进清单
    const src = await readFile(abs, "utf8");
    const d = parseDraft(src, r);
    const v = await validateDraft(p, r, src, r);
    const errors = v.diags.filter((x) => x.level === "error").length;
    const warnings = v.diags.filter((x) => x.level === "warning").length;
    const versions = await listVersions(p, r);

    // 体检记录：读数与健康判定都来自它（doc/00 §十五）
    const chk = await readCheck(p, r);
    const stale = !!chk && chk.srcSha256 !== sha256(src);
    const shot = chk?.screenshot ?? null;
    const hasShot = !!shot && existsSync(join(p.dir, shot));
    const { health, why } = judgeHealth(errors, warnings, chk, stale);

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
      health,
      healthWhy: why,
      diagnostics: { errors, warnings },
      // 过期的读数不往外给 —— 给了就等于拿旧数字描述新文件
      renderMs: chk && !stale ? chk.renderMs : null,
      nodeCount: chk && !stale ? chk.nodeCount : null,
      checkedAt: chk?.checkedAt ?? null,
      stale,
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

/** 索引过不过期。
 *
 * 为什么需要：`build_index` 是一次性扫目录，之后改稿它不知道 ——
 * 于是索引页上的元素数、健康、更新时间全是旧的，**而它看起来是新的**。
 * 「看起来是新的旧数据」比明显缺数据坏，所以要能说出来（和 §十五 的
 * 体检读数过期是同一条道理）。
 *
 * 判据：任一份稿的 mtime 晚于 index-data.json 的 generatedAt，或者稿的
 * 数量/名单变了。只比 mtime 不比内容 —— 便宜，而且「碰过就该重扫」这个判断
 * 偏保守的方向是对的。
 */
export async function indexStatus(p: Project): Promise<{
  exists: boolean; generatedAt: string | null; stale: boolean; reason: string | null;
  changed: string[]; added: string[]; removed: string[]; draftCount: number;
}> {
  const dataFile = join(p.dir, ".umbradesign", "index-data.json");
  const files = (await listDrafts(p))
    .map((a) => rel(p, a)).filter((r) => !isToolPage(r));
  if (!existsSync(dataFile)) {
    return { exists: false, generatedAt: null, stale: true, reason: "还没跑过 build_index",
      changed: [], added: files, removed: [], draftCount: files.length };
  }
  const data = JSON.parse(await readFile(dataFile, "utf8")) as IndexData;
  const at = Date.parse(data.project.generatedAt);
  const known = new Map(data.drafts.map((d) => [d.file, d]));

  const changed: string[] = [];
  const added: string[] = [];
  for (const f of files) {
    if (!known.has(f)) { added.push(f); continue; }
    const m = (await stat(join(p.dir, f))).mtime.getTime();
    if (m > at) changed.push(f);
  }
  const removed = [...known.keys()].filter((f) => !files.includes(f));

  const bits: string[] = [];
  if (added.length) bits.push(`新增 ${added.length} 份`);
  if (removed.length) bits.push(`少了 ${removed.length} 份`);
  if (changed.length) bits.push(`${changed.length} 份在索引之后改过`);
  return {
    exists: true, generatedAt: data.project.generatedAt,
    stale: bits.length > 0,
    reason: bits.length ? bits.join(" · ") + " —— 重跑 build_index" : null,
    changed, added, removed, draftCount: files.length,
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
  /** 点选桥落在哪 —— 预览壳要注入它 */
  bridgeFile: string | null;
  /** 部署进项目的其余壳页面 */
  shells: string[];
  /** 更新过租户 .gitignore 的工具产物段就给路径，没动就是 null */
  ignoreUpdated: string | null;
  /** 本地 API 有没有起来（没起 serve 就没有） */
  api: boolean;
  /** 落盘前做了哪几步确定性改写（与 write_draft 同一条路） */
  steps: string[];
}

/** 工具界面：入口页之外的壳。放项目根 —— 必须和稿同源，
 *  否则壳既注入不了点选桥、也调不了本地 API（都是同源前提）。
 *  它们是生成物，租户 .gitignore 模板里已排除。 */
const SHELLS = [
  "S2-单稿预览壳.dc.html",
  "S3-诊断面板.dc.html",
  "S4-变更清单.dc.html",
  "S5-设计系统浏览器.dc.html",
  // 形制稿。不接数据，但要能在项目目录下打开 —— 它是属性面板的判据来源（doc/10 §五）。
  "S7-属性面板.dc.html",
  // S7 靠 dc-import 引它。不跟着落盘，S7 在项目目录下就解析不到（E_IMPORT_MISSING）。
  "IconGlyph.dc.html",
];

/** 这是工具自己的页面，不是设计稿 —— 索引与接口的稿件清单都要排掉它，
 *  否则工具界面会出现在自己的稿件列表里。 */
export function isToolPage(rel: string): boolean {
  return rel === "index.dc.html" || SHELLS.includes(rel);
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
export function injectIndexData(src: string, data: IndexData, api?: { base: string; token: string } | null): string {
  // API 信息和索引数据一起注入。令牌只出现在壳页面里 —— 别的页面拿不到，
  // 这是 /__ud/* 那道门的前提（doc/00 §20.2）。
  const apiLine = api
    ? `window.__UD_API = ${JSON.stringify(api)};`
    : `window.__UD_API = null;`;
  const block = `${DATA_OPEN}\n<script>window.__UD_INDEX = ${JSON.stringify(data)};${apiLine}</script>\n${DATA_CLOSE}`;
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

/** 让租户的 `.gitignore` 跟得上我们**实际部署了什么**。
 *
 *  为什么不靠模板：`doc/_模板-租户 .gitignore` 是新建项目时拷一次的，
 *  之后我们加了 S7 和 IconGlyph，模板和已有项目就都落后了 ——
 *  实测就是这样：探针项目的 .gitignore 是旧版，缺整个「工具界面与入口页」段，
 *  于是 build_index 生成的文件全变成那个仓库里的未跟踪文件。
 *
 *  部署了什么只有 build_index 自己知道，所以这件事归它做。
 *  整段带标记、整段替换，幂等；没有 .gitignore 就不建（不替人决定要不要用 git）。
 */
const IGNORE_OPEN = "# <umbradesign:generated> —— 这一段由 build_index 维护，别手改";
const IGNORE_CLOSE = "# </umbradesign:generated>";

async function ensureIgnored(p: Project, deployed: string[]): Promise<string | null> {
  const gi = join(p.dir, ".gitignore");
  if (!existsSync(gi)) return null;                 // 没用 git 就不管
  const cur = await readFile(gi, "utf8");
  const block = [
    IGNORE_OPEN,
    "# 工具产物：入口页、界面壳、索引数据、皮肤、运行时副本。都可由稿件重算。",
    ...deployed.sort(),
    IGNORE_CLOSE,
  ].join("\n");

  const a = cur.indexOf(IGNORE_OPEN);
  const z = cur.indexOf(IGNORE_CLOSE);
  let next: string;
  if (a >= 0 && z > a) {
    next = cur.slice(0, a) + block + cur.slice(z + IGNORE_CLOSE.length);
  } else {
    next = cur.replace(/\s*$/, "") + "\n\n" + block + "\n";
  }
  if (next === cur) return null;
  await writeAtomic(gi, next);
  return rel(p, gi);
}

export interface BuildIndexOpts {
  renderCheck?: boolean;
}

export async function buildIndex(p: Project, serveUrl: string | null, opts?: BuildIndexOpts): Promise<BuildIndexResult> {
  // M4-5: 如果要求，先跑渲染体检生成截图
  if (opts?.renderCheck) {
    const files = await listDrafts(p);
    for (const abs of files) {
      const r = rel(p, abs);
      if (isToolPage(r)) continue;
      const chk = await readCheck(p, r);
      const hasShot = chk?.screenshot && existsSync(join(p.dir, chk.screenshot));
      if (!hasShot) {
        await renderCheck(p, r, { screenshot: true }).catch(() => { /* 单份失败不阻断 */ });
      }
    }
  }

  const data = await collectIndex(p);
  const udDir = join(p.dir, ".umbradesign");
  await mkdir(udDir, { recursive: true });

  const dataFile = join(udDir, "index-data.json");
  await writeFile(dataFile, JSON.stringify(data, null, 1) + "\n", "utf8");

  const jsFile = join(p.dir, "index-data.js");
  await writeAtomic(jsFile, `/* 由 build_index 生成，勿手改 */\nwindow.__UD_INDEX = ${JSON.stringify(data)};\n`);

  // 预览点选桥：壳在 iframe 载入后注入它（doc/00 §十九）。放 .umbradesign/ 下 ——
  // 它是工具行为，不是设计事实，不进稿也不进设计系统目录。
  const srcBridge = join(TOOL_ROOT, "runtime", "select-bridge.js");
  let bridgeFile: string | null = null;
  if (existsSync(srcBridge)) {
    const dst = join(udDir, "select-bridge.js");
    await copyFile(srcBridge, dst);
    bridgeFile = rel(p, dst);
  }

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
  const serve = serveOf(p.name);
  const api = serve ? { base: serve.url.replace(/\/$/, "") + "/__ud/", token: serve.token } : null;
  const raw = injectIndexData(useDesigned ? await readFile(designed, "utf8") : page(data), data, api);

  // ⚠️ 必须走 prepareForDisk，和 write_draft 同一条路 —— 否则入口页没有
  // __resources 注入，断网直接白屏。验证时实测踩到了：直接 writeAtomic 写出来的页
  // 去 unpkg 取 React，被拦之后 `[dc] failed to load React or boot`。
  // 「唯一写入口」这条规矩管的就是这个，工具自己产的文件也不例外。
  const indexFile = join(p.dir, "index.dc.html");
  const prep = prepareForDisk(p, raw);
  await writeAtomic(indexFile, prep.content);
  prep.steps.push("注入 window.__UD_INDEX 索引数据");
  const runtimeCopied = await ensureRuntimeBeside(indexFile);

  // 其余壳页面：同一条落盘路，同样注入
  const shells: string[] = [];
  for (const name of SHELLS) {
    const from = join(TOOL_ROOT, "ui", name);
    if (!existsSync(from)) continue;
    const prepS = prepareForDisk(p, injectIndexData(await readFile(from, "utf8"), data, api));
    const to = join(p.dir, name);
    await writeAtomic(to, prepS.content);
    shells.push(rel(p, to));
  }

  /* 部署清单 = 我们真的往项目目录里写过的东西。交给 .gitignore 那一段。 */
  const ignored = await ensureIgnored(p, [
    "index.dc.html", "index-data.js", "_ds-tool/", "_runtime/", ".umbradesign/",
    "react.production.min.js", "react-dom.production.min.js", "support.js",
    ...SHELLS,
  ]);
  if (ignored) prep.steps.push(`更新 ${ignored} 的工具产物忽略段`);

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
    bridgeFile,
    shells,
    ignoreUpdated: ignored,
    api: !!api,
    steps: prep.steps,
  };
}

export { esc };
