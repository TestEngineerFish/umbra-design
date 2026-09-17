/** 一个够用的 JS / HTML 扫描器。
 *
 * 不引解析库：稿子是"普通 JS + 普通 HTML"，需要的只是
 *  ① 按行列定位；② 对象字面量的顶层键；③ 字符串 / 注释 / 模板串的边界。
 * 凡是拿不准的地方一律标 opaque，**不报不能证明的错**（doc/04 §2.5）。
 */

export interface Pos { line: number; col: number }

/** 把绝对下标换成 1 起的行列 */
export function posOf(src: string, index: number): Pos {
  let line = 1, last = -1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { line++; last = i; }
  }
  return { line, col: index - last };
}

/** 行号表：建一次、查多次，避免 O(n²) */
export function lineIndex(src: string): (index: number) => Pos {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= index) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: index - (starts[lo] as number) + 1 };
  };
}

/** 从 open 处（必须是 '{'）做括号配平，返回闭合 '}' 的下标；不配平返回 -1。
 *  跳过字符串、模板串（含 ${} 嵌套）、行注释与块注释。 */
export function matchBrace(src: string, open: number): number {
  if (src[open] !== "{") return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); if (n < 0) return -1; i = n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); if (n < 0) return -1; i = n + 1; continue; }
    if (c === "/" && regexCanStart(src, i)) { const n = skipRegex(src, i); if (n > 0) { i = n; continue; } }
    if (c === '"' || c === "'") { const n = skipQuoted(src, i, c); if (n < 0) return -1; i = n; continue; }
    if (c === "`") { const n = skipTemplate(src, i); if (n < 0) return -1; i = n; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function skipQuoted(src: string, start: number, q: string): number {
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === q) return i;
    if (c === "\n") return -1; // 普通字符串不跨行
  }
  return -1;
}

function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") return i;
    if (c === "$" && src[i + 1] === "{") {
      const end = matchBrace(src, i + 1);
      if (end < 0) return -1;
      i = end;
    }
  }
  return -1;
}

export interface ObjectShape {
  /** 顶层键名 */
  keys: string[];
  /** ...展开 的表达式原文（已 trim） */
  spreads: string[];
  /** true = 结构里有搞不定的东西（计算键等），审计要放弃而不是误报 */
  opaque: boolean;
  /** opaque 是怎么来的 —— 分类用，也让诊断能说清楚 */
  why: string[];
  /** 键 → 值表达式原文。L1 要靠它判「这个值人能不能直接改」（doc/09 §3.1） */
  values: Record<string, string>;
}

/** 取对象字面量的顶层键。open 必须指向 '{'。 */
/** 剥掉一个片段开头的所有 // 与 /* * / 注释（可以连着好几个） */
function stripLeadingComments(seg: string): string {
  let s = seg;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("//")) {
      const n = t.indexOf("\n");
      if (n < 0) return "";            // 整段都是行注释
      s = t.slice(n + 1); continue;
    }
    if (t.startsWith("/*")) {
      const n = t.indexOf("*/", 2);
      if (n < 0) return "";            // 注释没闭合 —— 交给上层判
      s = t.slice(n + 2); continue;
    }
    return t;
  }
}

export function objectTopLevel(src: string, open: number): ObjectShape {
  const close = matchBrace(src, open);
  const out: ObjectShape = { keys: [], spreads: [], opaque: false, why: [], values: {} };
  const bail = (r: string) => { out.opaque = true; if (!out.why.includes(r)) out.why.push(r); };
  if (close < 0) { bail("对象括号不配平"); return out; }

  let i = open + 1;
  let depth = 0;          // 顶层 = 0（括号 / 方括号 / 花括号都算）
  let segStart = i;
  const segs: Array<[number, number]> = [];

  for (; i < close; i++) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? close : n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? close : n + 1; continue; }
    if (c === "/" && regexCanStart(src, i)) { const n = skipRegex(src, i); if (n > 0) { i = n; continue; } }
    if (c === '"' || c === "'") { const n = skipQuoted(src, i, c); if (n < 0) { bail("字符串没闭合"); return out; } i = n; continue; }
    if (c === "`") { const n = skipTemplate(src, i); if (n < 0) { bail("模板字符串没闭合"); return out; } i = n; continue; }
    if (c === "{" || c === "(" || c === "[") {
      if (c === "{") { const n = matchBrace(src, i); if (n < 0) { bail("花括号不配平"); return out; } i = n; continue; }
      depth++; continue;
    }
    if (c === "}" || c === ")" || c === "]") { depth--; continue; }
    if (c === "," && depth === 0) { segs.push([segStart, i]); segStart = i + 1; }
  }
  segs.push([segStart, close]);

  for (const [a, b] of segs) {
    // ⚠️ 切段时注释被跳过了（找逗号用），但段里还留着 —— 于是
    // `/* 说明 */ key: value` 这种段以 "/*" 开头，键名匹配不上，整份稿被判 opaque。
    // 实测：57 份稿里 25 份放弃审计，52 条原因中的 48 条就是这一个 bug
    // （设计稿里逐键写说明是常态，见 doc/06）。这里剥掉前导注释，
    // 不是放宽判据 —— 判据本来就该认得出这些键。
    const seg = stripLeadingComments(src.slice(a, b)).trim();
    if (!seg) continue;
    if (seg.startsWith("...")) { out.spreads.push(seg.slice(3).trim()); continue; }
    // key: value / 'key': value / "key": value / key（简写）/ key(){}（方法简写）
    const m = seg.match(/^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(?::|\(|$)/);
    if (m) {
      const key = (m[2] ?? m[3]) as string;
      out.keys.push(key);
      // 值原文：冒号之后到段末。简写（`key,`）与方法简写（`key(){}`）没有冒号，
      // 前者等于同名变量，后者是函数 —— 两种都不是人能直接改的字面量
      const colon = seg.indexOf(":", m[0].length - 1);
      out.values[key] = colon >= 0 ? seg.slice(colon + 1).trim() : seg.trim();
      continue;
    }
    if (/^\[/.test(seg)) { bail("计算键 [expr]"); continue; }
    bail("认不出的键形态：" + seg.slice(0, 40).replace(/\s+/g, " "));
  }
  return out;
}

/** 找一个方法体的 '{' 下标：name 后面第一个 '(' 配平完之后的 '{' */
/** 标出哪些下标是**真代码**（不在字符串 / 模板串 / 注释里）。
 *
 * ⚠️ 为什么需要这个：`methodBodyBrace` 原来拿正则找第一个 `name(` 就定了，
 * 而实测这一下踩得很惨 —— S2 的第一个 `renderVals(` 出现在**字符串**里
 * （演示用的诊断文案「…在 renderVals() 的顶层键里找不到」），
 * 《Umbra PC 端》的第一个出现在**块注释**里。两份稿因此被判「没有 renderVals()」，
 * 整份稿的洞审计直接放弃（doc/00 §19.4）。
 */
/** `/` 在这个位置是不是正则字面量的开头。
 *
 * JS 词法上 `/` 既是除号也是正则开头，只能看前一个有意义的字符来分。
 * 通行的启发式：前面是运算符 / 分隔符 / 关键字结尾 -> 正则；是值 -> 除号。
 *
 * 为什么非要处理它 —— 四个扫描器原来都对正则字面量视而不见，后果实测两条：
 *  1) `.replace(/^.*\//, "")` 的正则以反斜杠加两个斜杠收尾，扫描器把后一个斜杠
 *     看成行注释的开头，吞掉整行。S2 的 renderVals 键表因此从 86 个
 *     **悄悄截断到 3 个，而 opaque 仍是 false** —— 静默给错答案，比拒答坏得多
 *  2) `matchBrace` 遇到 `/\d{2}/` 这种正则会把里面的花括号算进深度，配平直接错
 * 两条都属于「不报错但算错」，按 doc/04 §二的判据必须堵掉。
 */
function regexCanStart(src: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(src[i] as string)) i--;
  if (i < 0) return true;
  const c = src[i] as string;
  if ("([{,;:=!&|?+-*%~^<>".includes(c)) return true;
  const word = /[\w$]+$/.exec(src.slice(Math.max(0, i - 11), i + 1));
  const KW = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await"];
  return !!word && KW.includes(word[0]);
}

/** 跳过一个正则字面量，返回收尾斜杠的下标；认不出返回 -1（正则不跨行，不硬猜） */
function skipRegex(src: string, at: number): number {
  let i = at + 1, inClass = false;
  for (; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "\\") { i++; continue; }
    if (c === "\n") return -1;
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "/") return i;
  }
  return -1;
}

export function codeMask(src: string): Uint8Array {
  const m = new Uint8Array(src.length);   // 1 = 真代码
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === "/" && regexCanStart(src, i)) { const n = skipRegex(src, i); if (n > 0) { i = n + 1; continue; } }
    if (c === '"' || c === "'") { const n = skipQuoted(src, i, c); i = n < 0 ? src.length : n + 1; continue; }
    if (c === "`") { const n = skipTemplate(src, i); i = n < 0 ? src.length : n + 1; continue; }
    m[i] = 1; i++;
  }
  return m;
}

export function methodBodyBrace(src: string, name: string, from = 0): number {
  const re = new RegExp(`(?:^|[^\\w$.])${name}\\s*\\(`, "g");
  re.lastIndex = from;
  const mask = codeMask(src);
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // 匹配落在字符串 / 注释里就跳过，接着找下一个
    const nameAt = src.indexOf(name, m.index);
    if (!mask[nameAt]) continue;
    let i = src.indexOf("(", m.index);
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src[i] === "{") return i;
  }
  return -1;
}

/** 找出【属于这个方法本身】的 return 语句下标。
 *
 * 为什么不能直接 grep return：`rows: items.map(it => { if (it.divider) return {…} })`
 * 里的 return 是回调的，不是 renderVals 的返回路径。回归时这一条让 5 份能渲染的稿
 * 报出 11 条 E_RETURN_PATH_GAP，全是误报。
 *
 * 做法：从方法体的 '{' 开始逐字符走，维护一个花括号栈，每一帧记它是不是**函数体**
 * （前面紧跟 `=>`，或 `)` 且再往前是 function / 方法名）。栈里只要有函数体帧，
 * 这条 return 就不属于本方法。`if (x) return …` 这种块级花括号不影响归属。
 */
export function ownReturns(src: string, open: number, close: number): number[] {
  const out: number[] = [];
  const stack: boolean[] = [];   // true = 函数体帧
  let i = open + 1;

  const isFnBrace = (braceAt: number): boolean => {
    let k = braceAt - 1;
    while (k > open && /\s/.test(src[k] as string)) k--;
    if (src[k] === ">" && src[k - 1] === "=") return true;          // 箭头函数
    if (src[k] !== ")") return false;                                 // 不是参数表 → 块
    let depth = 0;                                                    // 回退过参数表
    for (; k > open; k--) {
      const c = src[k];
      if (c === ")") depth++;
      else if (c === "(") { depth--; if (depth === 0) { k--; break; } }
    }
    while (k > open && /\s/.test(src[k] as string)) k--;
    // function foo(...) / foo(...) / async function(...)
    let end = k + 1, st = k;
    while (st > open && /[\w$]/.test(src[st] as string)) st--;
    const word = src.slice(st + 1, end);
    if (word === "function" || word === "catch" || word === "") return word === "function";
    // 方法简写 name(...) {  → 是函数体；if/for/while/switch(...) { → 是块
    return !["if", "for", "while", "switch", "with"].includes(word);
  };

  for (; i < close; i++) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") { const n = src.indexOf("\n", i); i = n < 0 ? close : n; continue; }
    if (c === "/" && src[i + 1] === "*") { const n = src.indexOf("*/", i + 2); i = n < 0 ? close : n + 1; continue; }
    if (c === "/" && regexCanStart(src, i)) { const n = skipRegex(src, i); if (n > 0) { i = n; continue; } }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < close; j++) { if (src[j] === "\\") { j++; continue; } if (src[j] === c || src[j] === "\n") break; }
      i = j; continue;
    }
    if (c === "`") { const n = skipTemplateExported(src, i); i = n < 0 ? close : n; continue; }
    if (c === "{") { stack.push(isFnBrace(i)); continue; }
    if (c === "}") { stack.pop(); continue; }
    if (c === "r" && src.startsWith("return", i) && !/[\w$]/.test(src[i - 1] ?? " ") && !/[\w$]/.test(src[i + 6] ?? " ")) {
      if (!stack.some(Boolean)) out.push(i);
      i += 5;
    }
  }
  return out;
}

/** skipTemplate 的对外版本（ownReturns 要用） */
export function skipTemplateExported(src: string, start: number): number {
  return skipTemplate(src, start);
}
