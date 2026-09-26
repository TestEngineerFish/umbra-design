import { z } from "zod";
import { envelope } from "../envelope.js";
import { KIND_OF_EXT, readCatalog, whoHandles } from "../plugin/catalog.js";
import { listInstalled } from "../plugin/store.js";
import { pluginVersions } from "../plugin/install.js";
import { defineCap } from "./registry.js";

/** 插件市场（M11-6 接线，形制按 `ui/S17-插件市场.dc.html`）。
 *
 *  ⚠️ **买和付这一层还没有**（账号 / 支付 / 积分都等产品）。
 *  这里给的是「有什么可装 + 本机装了什么」，够把市场和已装两屏接成真的；
 *  价格与余额前端会接成**明确的未启用态**，不做成看起来能用但点了没反应。
 */
defineCap({
  name: "list_market", title: "市场里有什么插件", scope: "global",
  summary: [
    "目录 + 本机状态一次给全：每个插件带 `state`（`builtin` / `installed` / `bought` / `none`）。",
    "⚠️ **权限的权威出处是包里的 manifest**，目录里那份只是装之前给用户看的。",
  ].join("\n"),
  input: {},
  faces: ["mcp", "http"],
  http: { route: "market", method: "GET" },
  run: async () => {
    const catalog = await readCatalog();
    const installed = await listInstalled();
    const byId = new Map(installed.map((x) => [x.manifest.id, x]));
    const rows = await Promise.all(catalog.map(async (c) => {
      const got = byId.get(c.id);
      const vs = got && !got.bundled ? await pluginVersions(c.id) : { versions: [], current: null };
      return {
        ...c,
        kinds: [...new Set(c.formats.map((f) => KIND_OF_EXT[f.toLowerCase()]).filter(Boolean))],
        /* ⚠️ `bought` 这一态**现在永远不会出现** —— 没有账号就没有「买过」这回事。
           留着是因为它是设计稿里的四态之一，接线时前端要认得它；
           等账号做好了这里改一行就有了。**不把它删掉**，删了将来会忘。 */
        state: got?.bundled ? "builtin" : got ? "installed" : "none",
        installedVersion: got?.bundled ? c.version : vs.current,
        /* 装着的版本比目录里的旧 = 有新版本 */
        hasUpdate: !!got && !got.bundled && !!vs.current && vs.current !== c.version,
        unsigned: !!got && got.unsigned,
      };
    }));
    return envelope({ plugins: rows, kinds: [...new Set(rows.flatMap((r) => r.kinds))] }, [], { count: rows.length });
  },
});

defineCap({
  name: "who_handles", title: "有没有插件能编辑这种文件", scope: "global",
  summary: [
    "按扩展名问市场。**✎ 那颗钮要问它** —— 用户定的模型是：",
    "文件预览页右上角永远显示编辑图标，装了且在有效期内就直接编辑，否则引导去市场。",
    "所以「市场里有没有」和「本机装没装」是两个问题，这件答前一个。",
  ].join("\n"),
  input: { ext: z.string().describe("带点的小写扩展名，如 .mp4") },
  faces: ["mcp", "http"],
  http: { route: "who_handles", method: "GET" },
  run: async ({ ext }) => {
    const hits = await whoHandles(ext);
    return envelope({ ext, plugins: hits.map((c) => ({ id: c.id, name: c.name, price: c.price })) }, [], { count: hits.length });
  },
});
