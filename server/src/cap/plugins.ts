import { z } from "zod";
import { envelope } from "../envelope.js";
import { allowedCapNames } from "../plugin/host.js";
import { HOST_API_MAJOR } from "../plugin/manifest.js";
import { listInstalled, uninstall } from "../plugin/store.js";
import { defineCap } from "./registry.js";

/** 插件管理的能力（M11-4）。
 *
 *  ⚠️ 这几件**不给插件面**（`faces` 里没有 `plugin`）——
 *  插件能列出、装上、卸掉别的插件的话，一个恶意插件可以先把杀毒的那个卸了。
 */
defineCap({
  name: "list_plugins", title: "列出装了哪些插件", scope: "global",
  summary: "列出本机装的插件：id、名字、版本、认领哪些格式、要了什么权限。清单有毛病的也列出来并说清为什么 —— 静静不显示的话，用户只会看到「我装的插件不见了」。",
  input: {},
  faces: ["mcp", "http"],
  http: { route: "plugins", method: "GET" },
  run: async () => {
    const list = await listInstalled();
    return envelope({
      hostApi: HOST_API_MAJOR,
      /** 插件能调的宿主能力 —— 装插件时摆给用户看 */
      allowedCaps: allowedCapNames(),
      plugins: list.map((p) => ({
        id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
        surfaces: p.manifest.surfaces, kinds: (p.manifest.kinds ?? []).map((k) => k.id),
        permissions: p.manifest.permissions, ok: p.problems.length === 0, problems: p.problems,
      })),
    }, [], { count: list.length });
  },
});

defineCap({
  name: "uninstall_plugin", title: "卸载一个插件", scope: "global",
  summary: "删掉插件自己的目录。**插件改过的文件不动** —— 那是用户的东西。卸载后那种格式退回通用文件卡，不是打不开。",
  input: { id: z.string() },
  faces: ["mcp", "http"],
  http: { route: "plugin_uninstall", method: "POST" },
  run: async ({ id }) => {
    const gone = await uninstall(id);
    return envelope({ id, removed: gone }, [], {});
  },
});
