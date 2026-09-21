/** validate_draft 的静态校验。分级与码值见 doc/00 §六。
 *
 * 一条纪律：**不报不能证明的错**（doc/04 §2.5）。
 * 逻辑类里出现搞不定的展开时，洞审计整块放弃，并在 stats 里说明放弃了。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { E, W } from "./codes.js";
import { err, warn, type Diagnostic } from "./envelope.js";
import { auditRenderVals, parseDraft, type Draft } from "./draft.js";
import { matchBrace } from "./scan.js";
import type { Project } from "./project.js";

const VOID_TAGS = new Set(["area","base","br","col","embed","hr","img","input","link","meta",
  "param","source","track","wbr"]);
// ⚠️ SVG 的 path / circle / rect / use 这些【不是】void 元素 —— 它们能写成 <path></path>。
// 把它们当 void 会让 </path> 去跟外层的 <svg> 配对，一份 1,500 元素的稿能凭空报出几十条
// E_TAG_UNBALANCED（回归时实测到的第一个误报）。自闭合写法由 selfClosed 分支处理，够了。

const FRAMEWORK_TAGS = new Set(["x-dc","helmet","sc-if","sc-for","dc-import","x-import"]);

const KNOWN_TAGS = new Set([...FRAMEWORK_TAGS,
  "html","head","body","div","span","p","a","button","input","textarea","select","option","optgroup",
  "label","form","fieldset","legend","table","thead","tbody","tfoot","tr","td","th","caption","colgroup","col",
  "ul","ol","li","dl","dt","dd","h1","h2","h3","h4","h5","h6","header","footer","main","nav","aside","section",
  "article","figure","figcaption","hr","br","img","picture","source","video","audio","track","canvas","iframe",
  "svg","g","path","circle","ellipse","line","rect","polygon","polyline","text","tspan","defs","clippath",
  "lineargradient","radialgradient","stop","mask","pattern","use","symbol","filter","fegaussianblur","feoffset",
  "feblend","fecolormatrix","femerge","femergenode","foreignobject","marker","title","desc",
  "strong","em","b","i","u","s","small","sub","sup","code","pre","kbd","samp","var","mark","q","blockquote",
  "cite","abbr","time","data","dfn","ruby","rt","rp","bdi","bdo","wbr","details","summary","dialog","menu",
  "meter","progress","output","datalist","template","slot","style","script","link","meta","base","noscript",
  "address","hgroup","search","fencedframe","portal",
]);

export interface ValidateResult {
  diags: Diagnostic[];
  stats: Record<string, unknown>;
}

export function validateDraft(p: Project, relPath: string, src: string, fileLabel: string): ValidateResult {
  const d = parseDraft(src, relPath);
  const diags: Diagnostic[] = [];
  const f = fileLabel;

  // ── 结构前提 ──
  if (!d.template) {
    diags.push(err(E.TAG_UNBALANCED, f, { kind: "tag", name: "x-dc" },
      "找不到 <x-dc>…</x-dc> 模板区间",
      { fix: "骨架见 doc/02 §一：<x-dc> 装模板，<script data-dc-script> 装逻辑类" }));
    // 字段给全 —— 调用方（本地 API / 壳页面）拿到 undefined 会显示成 "undefined"
    return { diags, stats: { elements: 0, holes: 0, imports: 0, branches: 0, lists: 0, valKeys: 0, returnPaths: 0, holeAuditSkipped: true, holeAuditSkippedWhy: "没有 <x-dc> 模板区" } };
  }

  // ── E_TAG_UNBALANCED：按栈逐标签配平 ──
  diags.push(...checkBalance(d, f));

  // ── 注释里的标签字面量 ──
  // ⚠️ 降级为 warning。旧记录说它「会把注释提前关掉」，那是**流式**解析下的隐患；
  // 一次性渲染时 HTML 注释只在 --> 处结束，标签字面量无害。回归实测：《Umbra PC 端》
  // 与《窗口骨架》都带这种注释且都能渲染。真正会坏事的是没闭合的注释，那一条仍是 error。
  for (const c of d.comments) {
    const m = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(c.text);
    if (!m) continue;
    diags.push(warn(W.COMMENT_TAG, f, { kind: "tag", name: m[1] as string },
      `注释里出现了标签字面量 <${m[1]}>`,
      { ...d.at(c.start), fix: `流式渲染打开后这会把注释提前关掉；写成 ${m[1]} 而不是 <${m[1]}> 更稳` }));
  }
  if (/<!--(?:(?!-->)[\s\S])*$/.test(d.src)) {
    diags.push(err(E.COMMENT_TAG, f, { kind: "tag", name: "comment" },
      "有一个 <!-- 没有对应的 -->，后面整段都会被吞掉",
      { fix: "补上 -->" }));
  }

  // ── E_LOGIC_SYNTAX：逻辑类能不能编译 ──
  let logicOk = true;
  if (d.logic) {
    const js = d.src.slice(d.logic.start, d.logic.end);
    try {
      // 与运行时同样的编译方式（doc/02 §2.3），只编译不执行
      new Function("DCLogic", "React", js + "\n; return typeof Component;");
    } catch (e) {
      logicOk = false;
      diags.push(err(E.LOGIC_SYNTAX, f, { kind: "key", name: "Component" },
        `逻辑类编译不过：${(e as Error).message}`,
        { ...d.at(d.logic.start), fix: "经典 JS，无 import / export / TS 语法（doc/03 §4.1）" }));
    }
  }

  // ── E_HOLE_EXPRESSION：洞里出现表达式 ──
  for (const h of d.holes) {
    if (h.path || h.literal) continue;
    diags.push(err(E.HOLE_EXPRESSION, f, { kind: "hole", name: h.raw || "(空)" },
      `洞里出现了表达式 "{{ ${h.raw} }}"，模板只允许点号路径`,
      { ...h.pos, fix: "在 renderVals() 里算好，起个名字暴露出来（doc/02 §4.2）" }));
  }

  // ── 洞的正反向审计 ──
  const audit = auditRenderVals(d);
  const aliases = new Set(d.lists.map((l) => l.as).filter(Boolean) as string[]);
  const propKeys = new Set(Object.keys(d.props ?? {}).filter((k) => !k.startsWith("$")));
  const builtin = new Set(["children", "$index"]);
  const auditable = !audit.opaque && !audit.missing && logicOk;

  /* ⚠️ 漏报补丁（2026-09-21）：**没有逻辑类 ≠ 没有洞要审**。
   *
   * 原来 `audit.missing` 一律把整块洞审计跳过，理由写的是「纯静态稿」。
   * 但「纯静态稿」的真正判据是**模板里没有洞**，不是「没有逻辑类」——
   * 一份有 108 个洞却没有逻辑类的稿，每个洞都没有东西能填，
   * 运行时会把它们全渲染成空，而校验器报**零 error**。
   *
   * 实测踩到：S6 / S9 / S10 三份新稿就是这样混过去的（108 / 47 / 57 个洞，
   * 零 error），而它们连 support.js 都没引，根本不会 boot。
   * 这是**漏报**——和「不许误报」是同一条纪律的两面：工具说干净就必须真干净。
   */
  const realHoles = d.holes.filter((h) => h.root && !h.literal);
  if (!d.logic && realHoles.length) {
    const names = [...new Set(realHoles.map((h) => h.root as string))];
    diags.push(err(E.HOLES_WITHOUT_LOGIC, f, { kind: "hole", name: names.slice(0, 3).join(", ") },
      `模板里有 ${realHoles.length} 个洞（${names.length} 个根名），但这份稿没有逻辑类 —— ` +
      `没有任何东西能填它们，运行时会把它们全渲染成空`,
      { ...(realHoles[0]?.pos ?? {}),
        fix: '补一段 `<script type="text/x-dc" data-dc-script data-props="{}">`，' +
             "里面写 `class Component extends DCLogic { renderVals() { return { … } } }`；" +
             "真的不需要数据就把模板里的洞去掉（doc/02 §一）" }));
  }

  /* 有 <x-dc> 却没引 support.js：运行时不加载，浏览器把模板当普通 HTML 显示，
     `{{ … }}` 原样出现在画面上。这条和上面那条经常同时犯 —— 都是「骨架没写全」。 */
  if (d.template && !/<script[^>]*\ssrc\s*=\s*["'][^"']*support\.js["']/i.test(d.src)) {
    diags.push(err(E.RUNTIME_NOT_LOADED, f, { kind: "tag", name: "script[src=support.js]" },
      "有 <x-dc> 模板，却没有引 support.js —— 运行时根本不加载，整份稿不会渲染",
      { fix: '在 <head> 里加 `<script src="./support.js"></script>`；' +
             "运行时三件套要与稿同层（check_runtime 可以查）" }));
  }

  if (auditable) {
    const valid = new Set([...audit.union, ...propKeys, ...aliases, ...builtin]);

    // 正向：模板里的根名必须有出处
    const reported = new Set<string>();
    for (const h of d.holes) {
      if (!h.root || h.literal) continue;
      if (valid.has(h.root) || reported.has(h.root + ":" + h.pos.line)) continue;
      reported.add(h.root + ":" + h.pos.line);
      const isCallable = h.position === "attr-whole" && /^on[A-Z]|Ref$/.test(h.root);
      diags.push(err(E.HOLE_UNRESOLVED, f, { kind: "hole", name: h.root },
        `模板第 ${h.pos.line} 行的洞 "${h.root}" 在 renderVals() 的顶层键里找不到`,
        { ...h.pos,
          fix: isCallable
            ? `在 renderVals() 的每一条返回路径里补 ${h.root}: P.${h.root} ?? NOOP`
            : `在 renderVals() 里返回 ${h.root}，或确认拼写` }));
    }

    // E_RETURN_PATH_GAP：某条返回路径缺模板用到的键
    const used = new Set(d.holes.map((h) => h.root).filter(Boolean) as string[]);
    if (audit.paths.length > 1) {
      for (const path of audit.paths) {
        const have = new Set(path.keys);
        const miss = [...used].filter(
          (k) => audit.union.includes(k) && !have.has(k) && !propKeys.has(k) && !aliases.has(k) && !builtin.has(k)
        );
        if (!miss.length) continue;
        diags.push(err(E.RETURN_PATH_GAP, f, { kind: "key", name: miss.slice(0, 4).join(", ") },
          `第 ${path.pos.line} 行那条 return 路径少了模板用到的键：${miss.slice(0, 6).join("、")}${miss.length > 6 ? ` 等 ${miss.length} 个` : ""}`,
          { ...path.pos, fix: "每一条返回路径（含早返回）都要给出模板用到的每一个键（doc/06 §3.2）" }));
      }
    }

    // W_DEAD_KEY：反向审计
    const tpl = d.src.slice(d.template.start, d.template.end);
    for (const k of audit.union) {
      if (used.has(k)) continue;
      if (tpl.includes(k)) continue; // 出现在别处（比如别名字段）就不算死键
      diags.push(warn(W.DEAD_KEY, f, { kind: "key", name: k },
        `renderVals() 返回的 "${k}" 在模板里零命中`,
        { fix: `删掉它，或在注释里说出它为什么留着（doc/06 §3.2）` }));
    }
  }

  // ── dc-import ──
  for (const im of d.imports) {
    if (im.selfClosing) {
      diags.push(err(E.IMPORT_SELF_CLOSING, f, { kind: "import", name: im.name },
        `<dc-import name="${im.name}"> 写成了自闭合`,
        { ...im.pos, fix: "必须写显式闭合标签 </dc-import>（doc/03 §3.1）" }));
    }
    if (!im.name) continue;
    const baseDir = dirname(resolve(p.dir, relPath));
    const target = resolve(baseDir, im.name + ".dc.html");
    if (!existsSync(target)) {
      diags.push(err(E.IMPORT_MISSING, f, { kind: "import", name: im.name },
        `dc-import 指向的 "${im.name}" 从 ${relPath} 所在目录解析不到`,
        { ...im.pos,
          fix: `路径以引用方文件为基准。跨目录要写相对路径，如 name="../Components/${im.name.split("/").pop()}"` }));
    }
  }

  // ── E_CONTROL_IN_TABLE：控制流标签落在 table / select 里 ──
  //
  // ⚠️ 这是 .dc.html 的一条格式硬约束，而且是**静默失效**：
  // HTML 的 foster-parenting 规定 <table>/<tbody>/<tr>/<select> 里只允许特定子元素，
  // 未知元素（sc-if / sc-for / dc-import）在解析时会被**搬到表外**。
  // 于是 support.js 拿到的 innerHTML 里控制流已经不在表里了 —— 行不渲染、不报错。
  // 实测踩到：build_index 生成的入口页用了真 <table> + sc-for，表头出来了、行全空。
  diags.push(...checkControlInTable(d, f));
  diags.push(...checkHoleInParsedAttr(d, f));

  // ── E_DS_PATH：展开后的 ds 引用要能落到真实文件 ──
  if (p.dsDir) {
    for (const l of d.helmetLinks) {
      const isDs = l.url.startsWith(p.dsAlias + "/") || l.url.startsWith(p.dsDir);
      if (!isDs) continue;
      const realRel = l.url.startsWith(p.dsAlias + "/")
        ? p.dsDir + l.url.slice(p.dsAlias.length)
        : l.url;
      if (!existsSync(join(p.dir, realRel))) {
        diags.push(err(E.DS_PATH, f, { kind: "path", name: l.url },
          `设计系统引用 "${l.url}" 解析不到真实文件`,
          { ...l.pos, fix: `project.json 里 designSystem.dir = "${p.dsDir}"，确认这个目录下有这个文件` }));
      }
    }
  }

  // ── W_HELMET_DUP：同一解析后 URL 重复 ──
  const seen = new Map<string, number>();
  for (const l of d.helmetLinks) {
    const key = normalizeUrl(l.url, p);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 2) {
      diags.push(warn(W.HELMET_DUP, f, { kind: "path", name: l.url },
        `helmet 里 "${key}" 被引用了多次，整份资源会跑两遍`,
        { ...l.pos, fix: "按解析后的绝对 URL 去重（doc/02 §4.4）" }));
    }
  }

  // ── W_FIXED_BLUR ──
  for (const sm of d.src.matchAll(/style\s*=\s*"([^"]*)"/gi)) {
    const v = sm[1] ?? "";
    if (!/position\s*:\s*fixed/i.test(v) || !/backdrop-filter\s*:/i.test(v)) continue;
    const idx = sm.index ?? 0;
    diags.push(warn(W.FIXED_BLUR, f, { kind: "tag", name: "style" },
      "同一个元素上同时有 position:fixed 与 backdrop-filter",
      { ...d.at(idx), fix: "保留 fixed，去掉滤镜，底色不透明度补偿（doc/06 §4.6）" }));
  }

  // ── W_HINT_IGNORED ──
  if (d.hints.length) {
    const first = d.hints[0] as { attr: string; pos: { line: number; col: number } };
    diags.push(warn(W.HINT_IGNORED, f, { kind: "tag", name: first.attr },
      `用了 ${d.hints.length} 处 hint-* 属性；第一阶段解析但忽略`,
      { ...first.pos, fix: "第一阶段不做流式渲染，新稿不必写 hint-*（doc/03 §八）" }));
  }

  // ── W_UNKNOWN_TAG ──
  for (const t of d.tags) {
    if (KNOWN_TAGS.has(t)) continue;
    if (t.includes("-")) continue; // 自定义元素（image-slot 这类），运行时会按外部组件处理
    diags.push(warn(W.UNKNOWN_TAG, f, { kind: "tag", name: t },
      `出现了既非 HTML/SVG 标准、也非框架标签的 <${t}>，大概率是拼错`,
      { fix: "标签名写错不报错，只会安静渲染成 0×0（doc/06 §6.2）" }));
  }

  // ── 元素数阈值 ──
  const { elementsWarn, elementsHard } = p.limits;
  if (d.elements > elementsHard) {
    diags.push(warn(W.ELEMENTS_HARD, f, { kind: "key", name: "elements" },
      `${d.elements} 个元素，超过 ${elementsHard} 的硬上限`,
      { fix: splitHint(d) }));
  } else if (d.elements > elementsWarn) {
    diags.push(warn(W.ELEMENTS_WARN, f, { kind: "key", name: "elements" },
      `${d.elements} 个元素，接近 ${elementsWarn} 的建议上限`,
      { fix: splitHint(d) }));
  }

  return {
    diags,
    stats: {
      elements: d.elements,
      holes: d.holes.length,
      imports: d.imports.length,
      branches: d.branches.length,
      lists: d.lists.length,
      valKeys: audit.union.length,
      returnPaths: audit.paths.length,
      holeAuditSkipped: !auditable,
      holeAuditSkippedWhy: auditable ? null
        : audit.missing ? (audit.opaqueWhy.join("；") || "没有 renderVals()") : !logicOk ? "逻辑类编译不过"
        : audit.opaqueWhy.join("；") || "renderVals 里有搞不定的展开或计算键",
    },
  };
}

function splitHint(d: Draft): string {
  if (d.imports.length) return `按 dc-import 边界拆（现有 ${d.imports.length} 处）`;
  const sections = (d.src.match(/<section\b/gi) ?? []).length;
  if (sections > 1) return `按顶层 section 拆（现有 ${sections} 个）`;
  if (d.branches.length > 1) return `按模块级 sc-if 分支拆（现有 ${d.branches.length} 处）`;
  return "按顶层 section 或 dc-import 边界拆（doc/00 §6.3）";
}

function normalizeUrl(url: string, p: Project): string {
  let u = url;
  if (p.dsDir && u.startsWith(p.dsAlias + "/")) u = p.dsDir + u.slice(p.dsAlias.length);
  u = u.replace(/^\.\//, "");
  // 折掉 ../ ，让"本层"与"上跳"写法归一（doc/02 §4.4 踩过的坑）
  const parts: string[] = [];
  for (const seg of u.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}

/** 控制流标签不许落在 table / select 的区间里（静默失效，见调用处的注释）。 */
/** 洞不能写在浏览器**解析 HTML 时就会动作或校验**的属性上。
 *
 * 两类，实测都踩过：
 *  - 会发请求：`src` / `href` / `srcset` / `poster` —— 浏览器在洞被替换前就去取
 *    字面量 `{{ x }}`，留一个 404（doc/00 §19.6）
 *  - 解析时校验：SVG 的 `d` / `points` / `viewBox` / `transform` / `cx`… ——
 *    浏览器立刻校验，控制台报
 *    `<path> attribute d: Expected moveto path command ('M' or 'm'), "{{ i.d }}"`
 *    （doc/00 §22.5）
 *
 * 两者都只污染控制台、不影响最终渲染，所以是 warning 不是 error。
 * 但 `render_check` 会把它算进控制台告警，按健康判据（§十五）这份稿就一直是黄的 ——
 * **一条永远好不了的黄，比没有这条检查更糟**，所以必须报出来并给改法。
 *
 * 改法：挂 `data-*` 上，逻辑类里在 `componentDidMount` / `componentDidUpdate` 抄过去
 * （S5 的图标就是这么改的）。
 */
/* ⚠️⚠️ 2026-09-18：**撤回的那半又收回来了。** 详见 doc/00 §二十七。
 *
 * 经过：这条检查本来管两类 —— 「会发请求」和「SVG 解析时按类型校验」。
 * 我用 render_check 反向验证后者，4 份真实语料 + 8 个合成形状全是零告警，
 * 于是按 doc/04 §二「未复现的不能当必改项」把 SVG 那一半撤了（§二十四），
 * 设计侧也照这条把 S5 改回了 `d="{{ i.d }}"`。
 *
 * 撤回是错的。`render.ts` 里有一行我自己写的
 *     if (/attribute .*Expected/.test(text)) return;
 * 把这一类控制台消息整段丢掉了 —— 反向验证用的就是这台被消音过的仪器，
 * 量到的零是仪器的零。这条现在已经删掉（改成单独归类上报）。
 *
 * 重新实测，判据换成完全不过滤的 console 监听，15 个形状，**100% 复现**：
 *   ✗ path d · polyline points · g transform · svg viewBox ·
 *     circle cx · circle r · svg width · rect x/y/width/height · line x1
 *   ✓ fill · stroke-width（涂装类宽容）· img width（HTML 宽容）·
 *     style 里的洞（CSS 静默丢弃）· use href（URL 宽容）·
 *     data-icon-d + 静态 d="M0 0"（推荐的修法本身，干净）
 *
 * 规律：**SVG 里按 length / number / transform / 路径数据这些类型解析的几何属性**，
 * 在解析那一刻就校验，那时洞还没被替换，所以必报。涂装类和 HTML 属性不校验。
 * 所以下面的 SVG 清单是**量出来的**，不是猜的 —— 不在清单里的属性一律不报。
 *
 * ⚠️ 判据必须看**宿主元素**，不能只看属性名。三条实测出来的边界：
 *
 *  1. `a[href]` 在解析时**不发请求**（只有 img / script / link / iframe / source /
 *     video / audio / embed / track / object 这些会）。报它是误报。
 *  2. `d` 只在 **SVG 元素**上被校验。抽图标组件之后写法是
 *     `<dc-import name="IconGlyph" d="{{ ic.d }}">` —— dc-import 是自定义元素，
 *     浏览器不校验它的 d，**那正是推荐的修法**，报它就是误报正确修法。
 *  3. `data-icon-d` 不能被 `\b` 命中（`-` 是非单词字符）—— 同样是修法本身。
 */
const FETCH_HOSTS: Record<string, string[]> = {
  img: ["src", "srcset"], script: ["src"], link: ["href"], iframe: ["src"],
  source: ["src", "srcset"], video: ["src", "poster"], audio: ["src"],
  embed: ["src"], track: ["src"], object: ["data"], input: ["src"],
};
/** 解析期按类型校验的 SVG 几何属性。清单是实测出来的（见上面的头注）。 */
const SVG_TYPED: Record<string, string[]> = {
  path: ["d"],
  polyline: ["points"], polygon: ["points"],
  g: ["transform"],
  svg: ["viewBox", "width", "height"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
};
/** polygon / ellipse 没单独测，但它们和 polyline / circle 是同一套属性类型
 *  （SVG 规范里同为 <points> 与 <length>），归在一起。拿不准的没往里加。 */

const WATCH_ATTRS = ["src", "href", "srcset", "poster", "data",
  "d", "points", "transform", "viewBox", "cx", "cy", "r", "rx", "ry",
  "x", "y", "x1", "y1", "x2", "y2", "width", "height"];

/** 这个 (宿主, 属性) 组合，浏览器在解析时会怎么出事。
 *  只认实测过的组合 —— 拿不准的一律不报（doc/04 §二：不报不能证明的错）。 */
function parseTimeRisk(tag: string, attr: string): "fetch" | "svg" | null {
  const t = tag.toLowerCase(), a = attr.toLowerCase();
  if (FETCH_HOSTS[t]?.includes(a)) return "fetch";
  // 属性名大小写：HTML 解析不分大小写，viewBox 在稿里也可能写成 viewbox
  if (SVG_TYPED[t]?.some((x) => x.toLowerCase() === a)) return "svg";
  return null;
}

function checkHoleInParsedAttr(d: Draft, f: string): Diagnostic[] {
  if (!d.template) return [];
  const out: Diagnostic[] = [];
  const tplStart = d.template.start;
  const tpl = d.src.slice(tplStart, d.template.end);
  for (const attr of WATCH_ATTRS) {
    // ⚠️ 不能用 \b 开头：`-` 是非单词字符，于是 `data-icon-d="{{ x }}"` 也会命中 ——
    // 而那正是我们推荐的改法，报它就是误报（实测自己踩了）。用负向后查排掉。
    const re = new RegExp(`(?<![-\\w])${attr}\\s*=\\s*"([^"]*\\{\\{[^"]*)"`, "gi");
    for (const m of tpl.matchAll(re)) {
      const at = m.index as number;
      const abs = tplStart + at;
      if (d.comments.some((c) => abs >= c.start && abs < c.end)) continue;
      // 往前找到宿主开标签的标签名
      const lt = tpl.lastIndexOf("<", at);
      const tag = lt < 0 ? "" : (/^<\s*([a-zA-Z][\w-]*)/.exec(tpl.slice(lt, at)) ?? ["", ""])[1] as string;
      const risk = parseTimeRisk(tag, attr);
      if (!risk) continue;
      out.push(risk === "fetch"
        ? warn(W.HOLE_IN_PARSED_ATTR, f, { kind: "key", name: `${tag}[${attr}]` },
            `<${tag}> 的 ${attr} 上写了洞 —— 浏览器在替换它之前就会去请求字面量，每次加载留一个 404`,
            { ...d.at(abs),
              fix: `静态值先写 about:blank（或占位路径），真地址在逻辑类的 componentDidMount / ` +
                   `componentDidUpdate 里设；或改挂 data-${attr.toLowerCase()} 再抄过去` })
        : warn(W.HOLE_IN_PARSED_ATTR, f, { kind: "key", name: `${tag}[${attr}]` },
            `<${tag}> 的 ${attr} 是解析期按类型校验的属性，上面写了洞 —— ` +
            `浏览器在替换它之前就校验，控制台必留一条 "attribute ${attr}: Expected …"`,
            { ...d.at(abs),
              fix: `洞挂到 data-${attr.toLowerCase()} 上、静态值给一个合法占位（d 给 "M0 0"），` +
                   `渲染后在 componentDidMount / componentDidUpdate 里抄进真属性；` +
                   `或者直接用 ui/IconGlyph.dc.html 那个子组件（doc/06 §2.8）` }));
    }
  }
  return out;
}

function checkControlInTable(d: Draft, f: string): Diagnostic[] {
  if (!d.template) return [];
  const out: Diagnostic[] = [];
  const tpl = d.src.slice(d.template.start, d.template.end);
  const HOSTS = ["table", "select", "optgroup"];
  const CONTROL = /<(sc-if|sc-for|dc-import|x-import)\b/gi;
  for (const host of HOSTS) {
    const open = new RegExp(`<${host}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = open.exec(tpl))) {
      // ⚠️ 宿主开标签本身也可能在注释里。实测踩到：注释里写了「不能用 <select> + sc-for」，
      // 这个 <select> 被当成未闭合的开标签，一路吞到文件末尾，把后面所有 sc-for 全报一遍
      // —— 一条**误报**，而且是在一份合法稿上（doc/00 §22.4）。
      // 下面 CONTROL 那一层本来就跳注释了，这一层漏了。
      const hostAbs = d.template.start + m.index;
      if (d.comments.some((x) => hostAbs >= x.start && hostAbs < x.end)) continue;
      const close = tpl.toLowerCase().indexOf(`</${host}>`, m.index);
      const end = close < 0 ? tpl.length : close;
      const inner = tpl.slice(m.index, end);
      CONTROL.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = CONTROL.exec(inner))) {
        const abs = d.template.start + m.index + c.index;
        if (d.comments.some((x) => abs >= x.start && abs < x.end)) continue;
        out.push(err(E.CONTROL_IN_TABLE, f, { kind: "tag", name: c[1] as string },
          `<${c[1]}> 落在 <${host}> 里面 —— HTML 解析会把它搬到 <${host}> 外面，于是这一段静默不渲染`,
          { ...d.at(abs),
            fix: `改用 div + CSS grid 排版（ui/S1-稿件索引.dc.html 就是这么做的，全稿零 <table>）；` +
                 `确实要 table 就把 <${c[1]}> 提到 <${host}> 外面，在 renderVals() 里把行拼好` }));
      }
      if (close < 0) break;
      open.lastIndex = close;
    }
  }
  return out;
}

/** 按栈逐标签配平（doc/06 自检 4）。只看模板区间。 */
function checkBalance(d: Draft, f: string): Diagnostic[] {
  if (!d.template) return [];
  const out: Diagnostic[] = [];
  const tpl = d.src.slice(d.template.start, d.template.end);
  const stack: Array<{ tag: string; index: number }> = [];
  // 引号感知：[^>]* 会被属性值里的裸 `>`（比如 data-props 的 "()=>void"）截断
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl))) {
    const abs = d.template.start + m.index;
    if (d.comments.some((c) => abs >= c.start && abs < c.end)) continue;
    const closing = m[1] === "/";
    const tag = (m[2] as string).toLowerCase();
    const selfClosed = m[4] === "/";
    if (tag === "script" || tag === "style") {
      // 内容当不透明：跳到对应结束标签
      const close = tpl.toLowerCase().indexOf(`</${tag}>`, m.index);
      if (close >= 0 && !closing) { re.lastIndex = close + tag.length + 3; continue; }
    }
    if (closing) {
      const top = stack.pop();
      if (!top) {
        out.push(err(E.TAG_UNBALANCED, f, { kind: "tag", name: tag },
          `多了一个 </${tag}>，前面没有对应的开标签`, { ...d.at(abs) }));
      } else if (top.tag !== tag) {
        out.push(err(E.TAG_UNBALANCED, f, { kind: "tag", name: tag },
          `</${tag}> 对不上：最近没闭合的是第 ${d.at(top.index).line} 行的 <${top.tag}>`,
          { ...d.at(abs), fix: "按栈逐标签配平，不要只数 sc-if（doc/06 自检 4）" }));
        stack.push(top); // 不吞掉，避免一处错引发连环报
      }
      continue;
    }
    if (selfClosed || VOID_TAGS.has(tag)) continue;
    stack.push({ tag, index: abs });
  }
  for (const left of stack.slice(0, 3)) {
    out.push(err(E.TAG_UNBALANCED, f, { kind: "tag", name: left.tag },
      `<${left.tag}> 没有闭合`, { ...d.at(left.index) }));
  }
  return out;
}

export { parseDraft };
