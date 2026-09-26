import { allCaps } from "../cap/index.js";
import type { Project } from "../project.js";
import { envelope, err } from "../envelope.js";
import { X } from "../codes.js";
import type { Envelope } from "../envelope.js";
import type { PluginManifest } from "./manifest.js";

/** 宿主 API v1（M11-4）。**插件的一切特权动作都从 `call` 这一个口出去。**
 *
 *  核心原则（`doc/20` §2.2 ②）：**插件没有任何环境权限**。
 *  它跑在沙箱里碰不到文件系统，要读写就回调这里 ——
 *  **权限由清单声明，由我们在宿主进程里核，不在沙箱里核**
 *  （在沙箱里核等于让嫌疑人自己签字）。
 *
 *  所以这个文件是整个插件机制的**咽喉**。改它之前先想清楚：
 *  新开的口子，一个恶意插件会怎么用。
 */

/** 哪些能力允许插件调，以及调它要什么权限。
 *
 *  ⚠️ **白名单，不是黑名单。** 没列在这里的能力插件一律调不到 ——
 *  包括将来新加的。黑名单的问题是「加了一件危险能力但忘了拉黑」，
 *  而那种疏漏不会有任何症状，直到出事。
 */
const ALLOWED: Record<string, { need: "read" | "write" }> = {
  list_files:         { need: "read" },
  read_file:          { need: "read" },
  list_file_versions: { need: "read" },
  list_file_refs:     { need: "read" },
  count_file_types:   { need: "read" },
  write_file:         { need: "write" },
  move_file:          { need: "write" },
  trash_file:         { need: "write" },
  revert_file:        { need: "write" },
};

export interface HostCtx {
  manifest: PluginManifest;
  project: Project;
}

const deny = (why: string, fix?: string): Envelope<null> =>
  ({ ok: false, data: null, errors: [err(X.BAD_INPUT, "(plugin)", { kind: "key", name: "permission" }, why, fix ? { fix } : undefined)], warnings: [], stats: {} });

/** 插件调一件宿主能力。**四道关，顺序不能换**。 */
export async function hostCall(ctx: HostCtx, name: string, input: unknown): Promise<Envelope<unknown>> {
  /* 关①：在不在白名单。先查这个 —— 不在的话连「它要什么权限」都不该告诉它 */
  const rule = ALLOWED[name];
  if (!rule) {
    return deny(`插件调不到能力 ${name}`,
      "插件只能调白名单里的宿主能力（见 server/src/plugin/host.ts 的 ALLOWED）。要新增请走宿主侧，别绕");
  }
  /* 关②：清单里声明过没有。声明了 read 却调 write 的，拒 */
  const have = ctx.manifest.permissions.files ?? [];
  if (!have.includes(rule.need)) {
    return deny(`${ctx.manifest.id} 的清单里没声明 files:"${rule.need}"，调不了 ${name}`,
      `在 manifest.json 的 permissions.files 里加 "${rule.need}"，用户装的时候会看到这一条`);
  }
  /* 关③：范围。第一期只有 project —— 插件看不到别的项目，也看不到用户主目录 */
  if ((ctx.manifest.permissions.scope ?? "project") !== "project") {
    return deny("第一期只支持 scope: project");
  }
  /* 关④：能力真的存在吗（注册表里可能还没搬过来） */
  const cap = allCaps().find((c) => c.name === name);
  if (!cap) return deny(`能力 ${name} 还没搬进 cap/ 注册表`, "见 doc/00 §八十三：能力在分批搬，这件还没轮到");

  /* 跑。`via: "plugin"` 会让变更记录写「插件」而不是 AI 或人手改 ——
     混在一起的话，用户看到「AI 改的」会去翻会话记录，而那一次根本没有会话。 */
  try {
    return await cap.run(input as never, { project: ctx.project, via: "plugin" });
  } catch (e) {
    return envelope(null, [err(X.IO, "(plugin)", { kind: "key", name: ctx.manifest.id },
      `插件 ${ctx.manifest.id} 调 ${name} 时出错：${(e as Error).message}`)]);
  }
}

/** 插件能调的能力清单（装插件时摆给用户看用，也给 `plugintest` 数数） */
export const allowedCapNames = (): string[] => Object.keys(ALLOWED);
