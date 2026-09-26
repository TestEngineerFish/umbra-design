/** 文件类型表的回归（M11-2，Q37）。
 *
 *  这一批把 `FileKind` 从编译期联合类型改成**运行期字符串表**，动的是
 *  「一个路径算什么类型」这种最底层的判断 —— 它错了，上面所有东西都错，
 *  而且症状是「这个文件打开的样子不对」，很难追回到这里。所以逐条钉死。
 *
 *  ⚠️ 这份**不是** `kindOf` 的单元测试，是**防回归**的对照表：
 *  每一行都对应一条曾经想清楚过的判断（为什么 `.svg` 归图片、为什么 `.json` 不归代码）。
 */
import {
  BUILTIN, PLUGIN_MAX_PRIORITY, isTextualPath, kindDef, kindOf, allKinds, registerKind, unregisterKindsFrom,
} from "./shared/kinds.js";

let pass = 0, fail = 0;
const ok = (c: boolean, what: string, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${what}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${what}${detail ? " — " + detail : ""}`); }
};

console.log("类型表（M11-2）");

/* ── ① 优先级：以前靠数组位置，现在靠 priority。这四条是「为什么要有顺序」的原因本身 ── */
const cases: Array<[string, string, boolean, string]> = [
  // 路径,                      该是什么,        是不是文本, 为什么钉它
  ["ui/S2-单稿预览壳.dc.html",  BUILTIN.dc,     true,  "设计稿要压过网页，否则整个设计稿能力凭空消失"],
  ["a/b/index.html",            BUILTIN.html,   true,  "普通网页还是网页"],
  ["logo.svg",                  BUILTIN.image,  true,  "svg 归图片（能无损缩放），但它是文本 —— 唯一的跨界情形"],
  ["tokens.json",               BUILTIN.json,   true,  "json 要压过代码：它有结构化的看法"],
  ["main.ts",                   BUILTIN.code,   true,  "代码"],
  ["readme.md",                 BUILTIN.md,     true,  "Markdown"],
  ["notes.txt",                 BUILTIN.code,   true,  "纯文本按代码看 —— 归 other 就没了预览和给 AI 读这两样"],
  ["clip.mp4",                  BUILTIN.other,  false, "没人认领的落到 other，且不是文本"],
  ["photo.PNG",                 BUILTIN.image,  false, "大写扩展名也认；图片默认不是文本"],
];
for (const [path, want, textual, why] of cases) {
  ok(kindOf(path) === want, `${path} → ${want}`, why);
  ok(isTextualPath(path) === textual, `${path} 是不是文本 = ${textual}`);
}
ok(kindOf("whatever", true) === BUILTIN.dir, "目录靠 isDir 认，不靠名字");

/* ── ② 插件注册：三道闸，每一道对应一种「装个插件把产品搞坏」的具体方式 ── */
registerKind({ id: "video", label: "视频", icon: "▶", priority: 50, match: (n) => n.endsWith(".mp4"), from: "com.umbra.video" });
ok(kindOf("clip.mp4") === "video", "插件加的类型立刻生效（运行期注册）");
ok(isTextualPath("clip.mp4") === false, "插件没声明 textual = 不是文本");
ok(kindDef("video").label === "视频", "插件类型的标签/图标也进表了");
ok(allKinds().includes("video"), "allKinds() 是函数，能看到插件加的种类（以前是常量，看不到）");

let threw = "";
try { registerKind({ id: "video", label: "又一个", icon: "?", priority: 50, match: () => false, from: "other" }); }
catch (e) { threw = (e as Error).message; }
ok(threw.includes("已经有了"), "闸①：重名当场抛 —— 静默覆盖的症状是「某种文件莫名换了视图」，很难追");

/* 闸② 对三种内置都要成立。⚠️ `dir` / `other` **不在 REG 里**（它们不靠名字认），
   所以重名那道闸拦不住它们 —— 只有内置这道闸拦得住。判据要把这三种都试到。 */
for (const id of [BUILTIN.dc, BUILTIN.dir, BUILTIN.other]) {
  threw = "";
  try { registerKind({ id, label: "劫持", icon: "!", priority: 100, match: () => true, from: "evil" }); }
  catch (e) { threw = (e as Error).message; }
  ok(threw.includes("内置类型"), `闸②：插件不能重定义内置类型 ${id}`, threw ? "" : "**没抛**");
}

/* 闸③ 是最要紧的一条：插件声明 999 也压不过 .dc.html */
registerKind({ id: "greedy", label: "贪心", icon: "!", priority: 999, match: (n) => n.endsWith(".dc.html"), from: "evil" });
ok(kindDef("greedy").priority <= PLUGIN_MAX_PRIORITY, "闸③：插件优先级被封顶", `声明 999 → 实际 ${kindDef("greedy").priority}`);
ok(kindOf("x.dc.html") === BUILTIN.dc, "**插件抢不走 .dc.html** —— 那是产品的核心格式，被劫持等于整个产品坏掉");

/* ── ③ 卸载：摘干净，不留半截 ── */
ok(unregisterKindsFrom("evil") === 1, "卸载按插件 id 摘");
ok(kindOf("x.dc.html") === BUILTIN.dc, "摘完还是对的");
ok(unregisterKindsFrom("com.umbra.video") === 1, "把视频也摘掉");
ok(kindOf("clip.mp4") === BUILTIN.other, "插件卸载后退回 other（文件卡），不是打不开");
ok(!allKinds().includes("video"), "卸载后种类表里也没了");

console.log(fail === 0 ? `\n✓ 类型表 ${pass}/${pass + fail}` : `\n✗ 类型表 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
