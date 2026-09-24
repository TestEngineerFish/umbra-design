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

export type FileKind = "dir" | "dc" | "md" | "image" | "json" | "code" | "html" | "other";

/** 一种类型的底层定义：怎么认出它、叫什么、用什么图标 */
export interface KindDef {
  id: FileKind;
  /** 界面上的中文名（目录视图的「类型」列、状态行都用它） */
  label: string;
  /** 单字符图标，树和列表共用一套 */
  icon: string;
  /** 按小写文件名判断。**顺序有意义** —— 见下面 KINDS 的注释 */
  match: (lowerName: string) => boolean;
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

/** **顺序即优先级**，越靠前越先匹配：
 *  - `.dc.html` 必须排在 `html` 前面，否则设计稿会被当成普通网页
 *  - `.svg` 归图片不归代码（它能无损缩放，看图更有用），所以 image 排在 code 前面
 *  - `.json` 排在 code 前面：`CODE_EXT` 里也有它，但 JSON 有结构化的看法，比纯文本有用
 */
export const KINDS: readonly KindDef[] = [
  { id: "dc", label: "设计稿", icon: "◧", match: (n) => n.endsWith(".dc.html") },
  { id: "md", label: "Markdown", icon: "≡", match: (n) => n.endsWith(".md") || n.endsWith(".markdown") },
  { id: "image", label: "图片", icon: "▣", match: (n) => endsWithAny(n, IMAGE_EXT) },
  { id: "json", label: "JSON", icon: "{}", match: (n) => n.endsWith(".json") || n.endsWith(".jsonc") },
  { id: "html", label: "网页", icon: "◻", match: (n) => n.endsWith(".html") || n.endsWith(".htm") },
  { id: "code", label: "代码", icon: "⟨⟩", match: (n) => endsWithAny(n, CODE_EXT) },
];

export const DIR_DEF: KindDef = { id: "dir", label: "目录", icon: "▤", match: () => false };
export const OTHER_DEF: KindDef = { id: "other", label: "其他", icon: "▢", match: () => true };

/** 一个路径是什么类型。传 `isDir` 是因为目录光看名字认不出来。 */
export function kindOf(path: string | null | undefined, isDir = false): FileKind {
  if (isDir) return "dir";
  if (!path) return "dir";
  const name = path.toLowerCase().split("/").pop() ?? "";
  return KINDS.find((k) => k.match(name))?.id ?? "other";
}

export function kindDef(id: FileKind): KindDef {
  if (id === "dir") return DIR_DEF;
  return KINDS.find((k) => k.id === id) ?? OTHER_DEF;
}

/** 全部种类，**运行时拿得到**（`FileKind` 是类型，编译完就没了）。
 *  前端用它自检「每一种 kind 都有模块认领」—— 少一种要当场喊，不能静悄悄落到文件卡。 */
export const ALL_KINDS: readonly FileKind[] = [...KINDS.map((k) => k.id), "dir", "other"];

export const KIND_LABEL = (id: FileKind): string => kindDef(id).label;
export const KIND_ICON = (id: FileKind): string => kindDef(id).icon;

/** 是不是**文本**：决定能不能读正文、能不能做摘录。
 *
 *  **按扩展名判，不按 kind 判** —— `.svg` 的 kind 是 image（它该用图片视图看，能无损缩放），
 *  但它本身是文本，读得出正文、也能让 AI 改。只看 kind 的话会把它误判成二进制。 */
export function isTextualPath(path: string): boolean {
  const name = path.toLowerCase().split("/").pop() ?? "";
  if (name.endsWith(".dc.html") || name.endsWith(".md") || name.endsWith(".markdown")) return true;
  if (name.endsWith(".html") || name.endsWith(".htm") || name.endsWith(".svg")) return true;
  return endsWithAny(name, CODE_EXT);
}
