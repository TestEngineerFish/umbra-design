import { createElement, type FC } from "react";
import { Seg } from "../toolbar";
import type { MenuItem, ViewContext } from "../context";
import { chromeKey, chromeOf, fire, useChrome } from "./chrome";
import { PluginSurface } from "./Surface";

/** 插件 chrome 的**画法**（M11-9）。数据来自插件（`chrome.ts`），形制来自我们。
 *
 *  这几个是**工厂**（返回组件）而不是组件本身 —— 每个插件要一套绑死了自己 id 的，
 *  而注册表要的是 `FC`，没法再传参数进去。 */

export const PluginToolbar = (pluginId: string): FC<{ ctx: ViewContext }> =>
  function Toolbar({ ctx }) {
    const key = chromeKey(pluginId, ctx.path);
    const c = useChrome(key);
    if (!c.toolbar.length && !c.buttons.length) return null;
    return (
      <>
        {c.toolbar.map((seg, si) => createElement(Seg, {
          key: seg.label, label: seg.label,
          items: seg.items.map((it, ii) => ({
            label: it.label, active: !!it.active, title: it.title, disabled: it.disabled, toggle: it.toggle,
            onPick: () => fire(key, "seg", si, ii),
          })),
        }))}
        <span className="flex-1" />
        {c.buttons.map((b, i) => (
          <button key={b.label} className={`btn sm shrink-0 ${b.primary ? "primary" : ""}`}
            title={b.title} disabled={b.disabled} onClick={() => fire(key, "button", i)}>{b.label}</button>
        ))}
      </>
    );
  };

export const PluginStatus = (pluginId: string): FC<{ ctx: ViewContext }> =>
  function Status({ ctx }) {
    const c = useChrome(chromeKey(pluginId, ctx.path));
    /* 空字符串时回退到类型名由工作台兜底 —— 这里返回 null 就够了
       （`registry.ts` 里记着：「省略等于空白」这条接口早晚有人踩，所以工作台有兜底） */
    return c.status ? <>{c.status}</> : null;
  };

export const pluginMenu = (pluginId: string) => (ctx: ViewContext): MenuItem[] => {
  /* ⚠️ 这是**普通函数不是组件**，用不了 hook —— 所以直接读状态而不是 `useChrome`。
     菜单是点 `⋯` 的那一刻才算的，读到的就是当时的值，不需要订阅。 */
  const key = chromeKey(pluginId, ctx.path);
  const c = chromeOf(key);
  return c.menu.map((mi, i) => mi.label === "—"
    ? { label: "—" }
    : { label: mi.label, hint: mi.hint, danger: mi.danger, run: mi.disabled ? undefined : () => fire(key, "menu", i) });
};

/** 插件的属性面板：**每个面板是它自己的一张网页**，各占一个沙箱 iframe。
 *
 *  为什么不像编辑栏那样「插件给数据、宿主画」：面板里装什么千变万化
 *  （大纲是树、颜色板是网格、视频是时间轴），给不出一套够用又不臃肿的词汇。
 *  编辑栏能这么做是因为它的词汇很小：段组、开关、几颗钮。 */
export const PluginPanels = (pluginId: string, panels: Array<{ pid: string; label: string; entry: string }>): FC<{ ctx: ViewContext }> =>
  function Panels({ ctx }) {
    const active = panels.find((p) => p.pid === ctx.ui.activePanel) ?? panels[0]!;
    return (
      <div className="flex h-full">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-8 px-3 flex items-center border-b border-border text-[11px] text-muted shrink-0">{active.label}</div>
          <PluginSurface ctx={ctx} pluginId={pluginId} entry={active.entry} role="panel" />
        </div>
      </div>
    );
  };
