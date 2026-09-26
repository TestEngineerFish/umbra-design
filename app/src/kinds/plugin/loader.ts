import { registerKind, unregisterKindsFrom } from "@shared/kinds";
import { register, unregisterFrom } from "../registry";
import { registerPanelTitle, unregisterPanelTitles } from "../../layout/layout";
import type { Core } from "../../api/client";
import { PluginSurface } from "./Surface";
import { PluginToolbar, PluginStatus, pluginMenu, PluginPanels } from "./ChromeUI";
import { createElement } from "react";

/** 把装好的插件接进来（M11-5）。
 *
 *  这一步用上了 M11-2 / M11-3 铺的两样东西：
 *  - **类型表是运行期的**（M11-2）—— 插件加的格式编译期不可能知道
 *  - **注册表能迟到注册**（M11-3）—— 插件是启动后才装的，注册完界面当场重画
 *
 *  ⚠️ 这里**只做接线，不做权限判断**。权限在服务端按清单核（`plugin/host.ts`）——
 *  放前端等于把门锁挂在门外面：插件改不了服务端，但页面它是能改的。
 */
export interface PluginRow {
  id: string; name: string; version: string;
  surfaces: Array<"ui" | "tools">;
  kinds: string[];
  ok: boolean;
  problems: Array<{ field: string; why: string }>;
}

/** 服务端给的那份表里没有 kind 的细节（扩展名等），所以这里要拿完整清单 */
interface FullKind { id: string; label: string; icon: string; ext: string[]; textual?: boolean; priority?: number }
interface FullPanel { id: string; label: string; entry: string }

const loaded = new Set<string>();

/** 拉一次插件表并接线。可以重复调（装完 / 卸完再调一次）。
 *  返回接上了几个、以及**没接上的原因** —— 静静不显示的话，
 *  用户只会看到「我装的插件不见了」。 */
export async function loadPlugins(core: Core): Promise<{ on: string[]; off: Array<{ id: string; why: string }> }> {
  const on: string[] = [], off: Array<{ id: string; why: string }> = [];
  const r = await core.get<{ plugins: Array<PluginRow & { manifest?: unknown }> }>("plugins").catch(() => null);
  if (!r?.ok || !r.data) return { on, off };

  const seen = new Set<string>();
  for (const p of r.data.plugins) {
    seen.add(p.id);
    if (!p.ok) { off.push({ id: p.id, why: p.problems[0] ? `${p.problems[0].field}：${p.problems[0].why}` : "清单有毛病" }); continue; }
    if (loaded.has(p.id)) continue;
    const full = await core.get<{ manifest: { kinds?: FullKind[]; ui?: string; panels?: FullPanel[]; surfaces: string[] } }>(
      `plugin_manifest?id=${encodeURIComponent(p.id)}`).catch(() => null);
    const man = full?.data?.manifest;
    if (!man) { off.push({ id: p.id, why: "读不到清单" }); continue; }

    try {
      for (const k of man.kinds ?? []) {
        registerKind({
          id: k.id, label: k.label, icon: k.icon, priority: k.priority ?? 50, textual: k.textual,
          /* 只按扩展名匹配 —— 清单里**不收正则**，正则能写出灾难性回溯把界面卡死 */
          match: (n) => k.ext.some((e) => n.endsWith(e)),
          from: p.id,
        });
      }
      /* UI 面：给它一块矩形。没有 ui 面的插件（只给 AI 用工具的）不注册模块 ——
         它的格式还是走通用文件卡，但 AI 多了几件能力。 */
      if (man.surfaces.includes("ui") && man.ui && (man.kinds ?? []).length) {
        /* 面板 id 带插件前缀 —— 否则两个插件都叫 `outline` 会撞，
           而布局里 `panelByKind` 记的就是这个 id，撞了会串。 */
        const panels = (man.panels ?? []).map((pl) => ({ ...pl, pid: `${p.id}.${pl.id}` }));
        for (const pl of panels) registerPanelTitle(pl.pid, pl.label);
        register({
          ids: (man.kinds ?? []).map((k) => k.id),
          from: p.id,
          panels: panels.map((pl) => pl.pid),
          View: ({ ctx }) => createElement(PluginSurface, { ctx, pluginId: p.id, entry: man.ui! }),
          /* chrome 四样**由宿主画**，插件只给数据（见 `chrome.ts` 的理由）。
             `Toolbar` 给 undefined 而不是空组件 —— 「有没有 ✎ 这颗钮」看的是它在不在，
             给个画不出东西的组件会让 ✎ 常驻而点开是空的。 */
          Toolbar: PluginToolbar(p.id),
          Status: PluginStatus(p.id),
          menu: pluginMenu(p.id),
          Panels: panels.length ? PluginPanels(p.id, panels) : undefined,
        });
      }
      loaded.add(p.id);
      on.push(p.id);
    } catch (e) {
      /* 注册撞车（两个插件抢同一种格式、或想劫持内置类型）会抛到这里。
         **把已经注册上的那部分摘掉** —— 留半截比不装还糟：
         类型表认得这种文件，模块表却没有，界面会落到文件卡上，看着像「插件没装」。 */
      unregisterKindsFrom(p.id); unregisterFrom(p.id); unregisterPanelTitles(p.id);
      off.push({ id: p.id, why: (e as Error).message });
    }
  }

  /* 装过又被卸掉的：摘干净 */
  for (const id of [...loaded]) if (!seen.has(id)) { unregisterKindsFrom(id); unregisterFrom(id); unregisterPanelTitles(id); loaded.delete(id); }
  return { on, off };
}
