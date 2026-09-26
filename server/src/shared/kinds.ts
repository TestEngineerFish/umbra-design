/** 文件类型的**唯一出处**（M8-14）。前端和后端都从这里认类型。
 *
 *  为什么要有这一份：在这之前，「一种文件格式」的知识散在六处 ——
 *  前端 `layout.ts` 的 `kindOf`、后端 `files.ts` 的 `kindOf`、`panelsFor`、
 *  `Workbench` 的三元链、`DirView` / `FileTree` 各自的图标表、`FileKind` 联合类型。
 *  加一种新格式要改六个地方，而且**前后端那两份扩展名映射没有任何机制保证一致** ——
 *  它们今天碰巧一致，纯属运气。
 *
 *  这份只管**最底层的那件事：一个路径是什么类型**。
 *  「这种类型用哪个视图、有哪些面板、工具栏长什么样」是前端的事，在 `app/src/kinds/` 里。
 *  分开是因为后端不需要知道 React 组件，前端也不该为了拿个扩展名去 import 服务端模块。
 *
 *  ⚠️ 这个文件被 `app/` 与 `server/` 两个 TS 工程同时引用，所以：
 *  **只用纯 TypeScript，不 import 任何东西，不用 Node 也不用 DOM 的 API。**
 */

/** 文件类型 id。**是 `string` 不是联合类型**（M11-2，Q37）。
 *
 *  以前这里是 `"dir" | "dc" | "md" | …` 的联合类型，编译期就定死了。
 *  插件要能加格式（比如买了视频插件就多一种 `video`），而**插件是装完才存在的** ——
 *  编译期不可能知道它叫什么。所以类型必须放开成字符串，种类表改成运行期注册。
 *
 *  放开的代价是丢了拼写检查（`kindOf(x) === "imgae"` 不再报错）。
 *  补偿是 `BUILTIN` 常量 + `kindtest` 那张对照表：内置的那几种用常量引用，
 *  拼错了编译期照样报；插件加的那些本来也不可能编译期检查。 */
export type FileKind = string;

/** 内置类型的 id。**引用内置类型一律用它，不要写字面量** ——
 *  写字面量的话 `FileKind` 放开成 string 之后拼错不会报错了。 */
export const BUILTIN = {
  dir: "dir", dc: "dc", md: "md", image: "image",
  json: "json", code: "code", html: "html", other: "other",
} as const;

/** 一种类型的底层定义：怎么认出它、叫什么、用什么图标 */
export interface KindDef {
  id: FileKind;
  /** 界面上的中文名（目录视图的「类型」列、状态行都用它） */
  label: string;
  /** 单字符图标，树和列表共用一套 */
  icon: string;
  /** 按小写文件名判断 */
  match: (lowerName: string) => boolean;
  /** **匹配优先级，大的先匹配**（M11-2）。
   *
   *  以前顺序靠数组位置，那在插件面前会塌 —— **运行时注册的插件插在数组哪儿是没有定义的**。
   *  比如装了个「网页编辑插件」，如果它排到了 `dc` 前面，`.dc.html` 会被当成普通网页打开，
   *  整个设计稿能力凭空消失。所以顺序必须显式。
   *
   *  内置取值见 `KINDS`。插件不给就是 `PLUGIN_DEFAULT_PRIORITY`，
   *  而且**封顶 `PLUGIN_MAX_PRIORITY`，抢不走 `.dc.html`**（见 `registerKind`）。 */
  priority: number;
  /** 这种类型的文件**是不是文本**（能读正文、能给 AI 读、能做摘录）。
   *
   *  给函数是因为同一种 kind 里可能只有部分是文本：`.svg` 的 kind 是 `image`
   *  （它该用图片视图看，能无损缩放），但它本身是文本，读得出正文也能让 AI 改。
   *  不写 = 不是文本。 */
  textual?: boolean | ((lowerName: string) => boolean);
  /** 哪个插件加的。内置的不写。卸载插件时按它把种类摘掉 */
  from?: string;
}

/** 后缀集合，拿出来是为了让「支持哪些扩展名」一眼看全、也方便别处复用 */
export const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp", ".ico"];
export const CODE_EXT = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".less",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".sql", ".graphql", ".vue", ".svelte",
  ".txt",   // 纯文本按代码看：它能预览、能给 AI 读，归到 other 反而少了这两样
];

const endsWithAny = (name: string, exts: string[]) => exts.some((e) => name.endsWith(e));

/** 插件没声明优先级时给它的值。落在 `html`(60) 和 `code`(10) 之间 ——
 *  插件能接管代码和未知类型，但接管不了我们有专门视图的那几种，除非它明说。 */
export const PLUGIN_DEFAULT_PRIORITY = 50;
/** 插件优先级的上限。**`dc`(100) 在它之上，插件永远抢不走 `.dc.html`** ——
 *  那是产品的核心格式，被插件劫持等于整个产品坏掉。 */
export const PLUGIN_MAX_PRIORITY = 95;

/** 内置类型。**优先级显式写出来**，不再靠数组位置：
 *  - `dc` 100 > `html` 60：否则设计稿被当成普通网页
 *  - `image` 80 > `code` 10：`.svg` 归图片（能无损缩放，看图更有用）
 *  - `json` 70 > `code` 10：`CODE_EXT` 里也有 `.json`，但 JSON 有结构化的看法
 */
const BUILTIN_KINDS: readonly KindDef[] = [
  { id: BUILTIN.dc, label: "设计稿", icon: "◧", priority: 100, textual: true, match: (n) => n.endsWith(".dc.html") },
  { id: BUILTIN.md, label: "Markdown", icon: "≡", priority: 90, textual: true, match: (n) => n.endsWith(".md") || n.endsWith(".markdown") },
  /* `.svg` 是图片里唯一的文本 —— 所以这里是函数不是 true */
  { id: BUILTIN.image, label: "图片", icon: "▣", priority: 80, textual: (n) => n.endsWith(".svg"), match: (n) => endsWithAny(n, IMAGE_EXT) },
  { id: BUILTIN.json, label: "JSON", icon: "{}", priority: 70, textual: true, match: (n) => n.endsWith(".json") || n.endsWith(".jsonc") },
  { id: BUILTIN.html, label: "网页", icon: "◻", priority: 60, textual: true, match: (n) => n.endsWith(".html") || n.endsWith(".htm") },
  { id: BUILTIN.code, label: "代码", icon: "⟨⟩", priority: 10, textual: true, match: (n) => endsWithAny(n, CODE_EXT) },
];

/** 活的种类表。内置的先进来，插件装上之后往里加。**按 priority 降序维护** */
const REG: KindDef[] = [...BUILTIN_KINDS];

/** 当前全部可匹配的种类（不含 dir / other 这两个不靠名字认的） */
export const KINDS = (): readonly KindDef[] => REG;

/** 注册一种类型。插件装上时调；内置的已经在表里了。
 *
 *  ⚠️ 三道闸，每一道都对应一种「装个插件把产品搞坏」的具体方式：
 *  ① 重名 —— 后注册的静默覆盖，症状是「某种文件莫名其妙换了视图」，很难想到是撞了
 *  ② 优先级封顶 —— 见 `PLUGIN_MAX_PRIORITY`
 *  ③ 不许动内置 —— 插件不能重定义 `dc` / `dir` / `other` 这些
 */
/** 这个 id 是不是**内置类型**。
 *
 *  ⚠️ 「定义一种新类型」和「**认领**一种已有类型」是两件事（M11-9b 分清的）：
 *  `md` 这种类型应该**一直是内置的** —— 就算 Markdown 插件没装，
 *  应用也该知道 `.md` 是 Markdown（显示图标、判断是文本、目录里归类）。
 *  搬去插件的只是**模块**（怎么看、怎么改），不是**类型**。 */
export const isBuiltinKind = (id: FileKind): boolean => !!(BUILTIN as Record<string, string>)[id];

export function registerKind(def: KindDef & { from: string }): void {
  /* ⚠️ **内置这道闸要排在重名前面**（kindtest 抓到的）：
     内置的 `dc` 本来就在表里，重名那道闸会先拦下，插件收到的提示是「已经有了」——
     听起来像是别的插件占了位置，而真相是「这个你永远不许动」。
     而 `dir` / `other` 压根不在 REG 里，**只有内置这道闸拦得住**。 */
  if ((BUILTIN as Record<string, string>)[def.id]) throw new Error(`${def.id} 是内置类型，插件不能重定义`);
  if (REG.some((k) => k.id === def.id)) throw new Error(`文件类型 ${def.id} 已经有了 —— 一种类型只能注册一次`);
  const priority = Math.min(def.priority ?? PLUGIN_DEFAULT_PRIORITY, PLUGIN_MAX_PRIORITY);
  REG.push({ ...def, priority });
  REG.sort((a, b) => b.priority - a.priority);
}

/** 卸载插件时把它加的类型摘掉。返回摘掉了几种 */
export function unregisterKindsFrom(pluginId: string): number {
  const before = REG.length;
  for (let i = REG.length - 1; i >= 0; i--) if (REG[i]!.from === pluginId) REG.splice(i, 1);
  return before - REG.length;
}

export const DIR_DEF: KindDef = { id: BUILTIN.dir, label: "目录", icon: "▤", priority: -1, match: () => false };
export const OTHER_DEF: KindDef = { id: BUILTIN.other, label: "其他", icon: "▢", priority: -2, match: () => true };

/** 一个路径是什么类型。传 `isDir` 是因为目录光看名字认不出来。 */
export function kindOf(path: string | null | undefined, isDir = false): FileKind {
  if (isDir) return "dir";
  if (!path) return "dir";
  const name = path.toLowerCase().split("/").pop() ?? "";
  /* REG 始终按 priority 降序，所以第一个匹配上的就是优先级最高的那个 */
  return REG.find((k) => k.match(name))?.id ?? BUILTIN.other;
}

export function kindDef(id: FileKind): KindDef {
  if (id === BUILTIN.dir) return DIR_DEF;
  return REG.find((k) => k.id === id) ?? OTHER_DEF;
}

/** 全部种类。**是函数不是常量了**（M11-2）——
 *  以前是个模块加载时算好的数组，插件装上之后它不会变，
 *  前端那条「每种 kind 都有模块认领」的自检就会漏掉插件加的种类。 */
export const allKinds = (): readonly FileKind[] => [...REG.map((k) => k.id), BUILTIN.dir, BUILTIN.other];

export const KIND_LABEL = (id: FileKind): string => kindDef(id).label;
export const KIND_ICON = (id: FileKind): string => kindDef(id).icon;

/** 是不是**文本**：决定能不能读正文、能不能做摘录。
 *
 *  M11-2 改成**问种类表**，不再在这里硬写一串扩展名 —— 插件加的格式是不是文本，
 *  只有插件自己知道。原来那串硬编码和 `KINDS` 是同一件知识的两份拷贝，
 *  加一种文本格式要改两处，而且**没有任何机制保证两处一致**（M8-14 修掉的正是这个病，这里漏了一处）。
 *
 *  `textual` 给函数是因为同一种 kind 里可能只有部分是文本 —— `.svg` 是 image 里唯一的那个。 */
export function isTextualPath(path: string): boolean {
  const name = path.toLowerCase().split("/").pop() ?? "";
  const def = REG.find((k) => k.match(name));
  if (!def) return false;
  return typeof def.textual === "function" ? def.textual(name) : !!def.textual;
}
