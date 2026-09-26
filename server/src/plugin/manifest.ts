import { PLUGIN_DEFAULT_PRIORITY } from "../shared/kinds.js";

/** 插件清单（M11-4，需求见 `doc/20`）。
 *
 *  清单是插件和宿主之间**唯一的声明**：它要哪些权限、认领哪些格式、有哪几个能力面。
 *  装的时候把它摆给用户看一眼，用户点同意才装。
 *
 *  ⚠️ **没有 `exec` 这一项**（`doc/20` P1，2026-09-26 用户定）：
 *  插件不许起子进程 —— 子进程不受父进程权限约束，开了这个口，
 *  Node 权限模型那道墙就等于虚设。要 ffmpeg 这类外部程序，
 *  由**宿主**提供一件受限能力（参数白名单），插件碰不到命令行。
 *  **连槽位都不留** —— 留着就会有人想填。
 */
export interface PluginManifest {
  /** 反写域名式的唯一 id。也是能力名的强制前缀（`com.umbra.video` → `com.umbra.video.trim`） */
  id: string;
  name: string;
  version: string;
  /** 宿主 API 的大版本要求，比如 `"^1"`。对不上就不装 —— 插件是独立更新的，版本错配是常态 */
  hostApi: string;
  /** 有哪几个能力面。没声明的**不加载** —— 只有工具面的插件根本不起 iframe */
  surfaces: Array<"ui" | "tools">;
  /** 它认领哪些文件类型。每一项会进运行期类型表（M11-2） */
  kinds?: Array<{
    id: string;
    label: string;
    icon: string;
    /** 认哪些扩展名（小写，带点）。**只给扩展名不给正则** —— 正则能写出灾难性回溯 */
    ext: string[];
    /** 是不是文本（能读正文、能给 AI 读）。不写 = 不是 */
    textual?: boolean;
    /** 匹配优先级。不给 = 50；**封顶 95，抢不走 `.dc.html`**（见 `shared/kinds.ts`） */
    priority?: number;
  }>;
  permissions: {
    /** 能对文件做什么。**一律通过 `host.call` 走两条写入口**，插件自己碰不到 fs */
    files?: Array<"read" | "write">;
    /** 看得到什么范围。`project` = 只有当前项目目录。**第一期只有这一种** */
    scope?: "project";
    /** 允许联网的域名。**空数组 = 完全不许**（CSP 会把 iframe 那半也锁死） */
    net?: string[];
  };
  /** UI 面的入口 HTML（相对插件目录）。`surfaces` 含 `ui` 时必须有 */
  ui?: string;
  /** 属性区里的面板，**每个是它自己的一张网页**（M11-9）。
   *  为什么不像编辑栏那样「给数据、宿主画」：面板里装什么千变万化
   *  （大纲是树、颜色板是网格、时间轴是时间轴），给不出一套够用又不臃肿的词汇。 */
  panels?: Array<{ id: string; label: string; entry: string }>;
  /** 工具面的入口 JS（相对插件目录）。`surfaces` 含 `tools` 时必须有 */
  tools?: string;
}

/** 宿主 API 的当前大版本。**插件对不上就不装。**
 *  改它的时机：改了 `host.*` 的形状且不向后兼容。加东西不用改。 */
export const HOST_API_MAJOR = 1;

export interface ManifestProblem { field: string; why: string }

/** 校验清单。**这是信任边界上的第一道关** —— 后面所有环节都假设清单是干净的。
 *
 *  返回问题清单而不是抛异常：装插件失败时要把**所有**毛病一次列给用户，
 *  而不是修一条报一条。 */
export function checkManifest(m: unknown): { ok: boolean; problems: ManifestProblem[]; manifest?: PluginManifest } {
  const p: ManifestProblem[] = [];
  const bad = (field: string, why: string) => { p.push({ field, why }); };
  if (!m || typeof m !== "object") return { ok: false, problems: [{ field: "(整份)", why: "不是一个对象" }] };
  const x = m as Record<string, unknown>;

  /* id 兼做能力名前缀和目录名，所以字符集要卡死：
     允许点和横杠混进路径分隔符或 `..` 的话，装的时候就能写到别处去。 */
  if (typeof x.id !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+){1,4}$/.test(x.id)) {
    bad("id", "要是反写域名式的小写 id，比如 com.umbra.video（只许小写字母数字和点、横杠）");
  }
  for (const k of ["name", "version"]) if (typeof x[k] !== "string" || !x[k]) bad(k, "必填");

  if (typeof x.hostApi !== "string") bad("hostApi", "必填，比如 \"^1\"");
  else {
    const want = /^\^?(\d+)/.exec(x.hostApi);
    if (!want) bad("hostApi", `看不懂：${x.hostApi}`);
    else if (Number(want[1]) !== HOST_API_MAJOR) {
      bad("hostApi", `要 ${x.hostApi}，本机宿主是 v${HOST_API_MAJOR} —— 插件和主程序是分别更新的，版本错配很常见，请更新插件或主程序`);
    }
  }

  const surfaces = Array.isArray(x.surfaces) ? x.surfaces : [];
  if (!surfaces.length) bad("surfaces", "至少要有一个能力面：ui（预览页编辑）或 tools（给大模型调用）");
  for (const s of surfaces) if (s !== "ui" && s !== "tools") bad("surfaces", `不认识的能力面：${String(s)}`);
  if (surfaces.includes("ui") && typeof x.ui !== "string") bad("ui", "声明了 ui 面就要给入口 HTML 的路径");
  if (surfaces.includes("tools") && typeof x.tools !== "string") bad("tools", "声明了 tools 面就要给入口 JS 的路径");
  for (const k of ["ui", "tools"]) {
    const v = x[k];
    /* 入口路径逃出插件目录 = 让它加载我们的文件。绝对路径和 `..` 一律拒 */
    if (typeof v === "string" && (v.startsWith("/") || v.includes("..") || v.includes("\\"))) {
      bad(k, "入口路径只能是插件目录内的相对路径，不许有 .. 或绝对路径");
    }
  }

  for (const [i, pl0] of (Array.isArray(x.panels) ? x.panels : []).entries()) {
    const pl = pl0 as Record<string, unknown>;
    const at = `panels[${i}]`;
    if (typeof pl.id !== "string" || !/^[a-z0-9_-]+$/.test(pl.id)) bad(at + ".id", "小写字母数字下划线横杠");
    if (typeof pl.label !== "string" || !pl.label) bad(at + ".label", "必填 —— 图标轨上要显示它");
    if (typeof pl.entry !== "string" || pl.entry.startsWith("/") || pl.entry.includes("..")) bad(at + ".entry", "插件目录内的相对路径，不许 .. 或绝对路径");
  }

  const kinds = Array.isArray(x.kinds) ? x.kinds : [];
  for (const [i, k0] of kinds.entries()) {
    const k = k0 as Record<string, unknown>;
    const at = `kinds[${i}]`;
    if (typeof k.id !== "string" || !/^[a-z0-9_-]+$/.test(k.id)) bad(at + ".id", "小写字母数字下划线横杠");
    for (const f of ["label", "icon"]) if (typeof k[f] !== "string" || !k[f]) bad(`${at}.${f}`, "必填");
    const ext = Array.isArray(k.ext) ? k.ext : [];
    if (!ext.length) bad(at + ".ext", "至少要认一个扩展名");
    for (const e of ext) {
      if (typeof e !== "string" || !/^\.[a-z0-9.]+$/.test(e)) bad(at + ".ext", `扩展名要是小写并带点，比如 .mp4（得到 ${String(e)}）`);
    }
    if (k.priority !== undefined && (typeof k.priority !== "number" || !Number.isFinite(k.priority))) {
      bad(at + ".priority", "要是数字");
    }
  }

  const perm = (x.permissions ?? {}) as Record<string, unknown>;
  if (typeof x.permissions !== "object" || !x.permissions) bad("permissions", "必填 —— 不声明权限的插件装不上（默认不是「全给」，是「拒装」）");
  for (const f of (Array.isArray(perm.files) ? perm.files : [])) {
    if (f !== "read" && f !== "write") bad("permissions.files", `只认 read / write（得到 ${String(f)}）`);
  }
  if (perm.scope !== undefined && perm.scope !== "project") bad("permissions.scope", "第一期只支持 project（只看得到当前项目目录）");
  for (const d of (Array.isArray(perm.net) ? perm.net : [])) {
    if (typeof d !== "string" || !/^[a-z0-9.-]+$/.test(d)) bad("permissions.net", `要是域名（得到 ${String(d)}）`);
  }
  /* P1：连槽位都不留。清单里写了 exec 就当场拒 —— 不是忽略它，
     忽略会让插件作者以为写了有用，进而依赖一个不存在的能力。 */
  if ("exec" in perm) bad("permissions.exec", "插件不许起子进程（doc/20 P1）。要外部程序请用宿主提供的受限能力");

  if (p.length) return { ok: false, problems: p };
  const mm = x as unknown as PluginManifest;
  for (const k of mm.kinds ?? []) k.priority ??= PLUGIN_DEFAULT_PRIORITY;
  return { ok: true, problems: [], manifest: mm };
}
