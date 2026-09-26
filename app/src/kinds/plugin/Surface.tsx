import { useEffect, useRef, useState } from "react";
import { toast } from "../../ui/Toast";
import { PopoverAt, PopItem, PopSep } from "../../ui/Popover";
import type { MenuItem, ViewContext } from "../context";

/** 插件 UI（A 面）的宿主（M11-5）。**插件画在它自己的一张网页里，我们只给一块矩形。**
 *
 *  为什么不是「把 React 组件递给插件」（Q37 原方案，已更正）：
 *  沙箱是**不透明源的 iframe**，`postMessage` 只传可序列化的数据 ——
 *  React 对象、组件、函数一个都过不去。改成 Figma 那套之后，
 *  版本耦合从根上没了：插件用什么框架我们完全不用管。
 *
 *  代价是**插件画不到自己矩形之外**。下拉菜单、toast 如果由插件自己画，
 *  会被矩形裁掉，而且和主程序的浮层形制对不上 —— 所以这些由**宿主代画**
 *  （`umbra.menu` / `umbra.toast`），出现在我们的浮层层里，形制和别处一致。
 */

/** 插件发过来的消息 */
type FromPlugin =
  | { t: "ready" }
  | { t: "call"; id: number; cap: string; input: unknown }
  | { t: "menu"; id: number; x: number; y: number; items: Array<{ label: string; hint?: string; danger?: boolean; disabled?: boolean }> }
  | { t: "toast"; title: string; body?: string; level?: "ok" | "error" };

export function PluginSurface({ ctx, pluginId, entry }: { ctx: ViewContext; pluginId: string; entry: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number; items: MenuItem[] } | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  /* 最新的上下文放 ref 里：插件 `ready` 的时机不定，到时候要拿当场的值推给它。
     直接闭包捕获的话拿到的是挂载那一刻的旧值。 */
  const ctxRef = useRef({ path: ctx.path, kind: ctx.kind });
  ctxRef.current = { path: ctx.path, kind: ctx.kind };
  const src = `${ctx.core.url.replace(/\/$/, "")}/__plugin/${pluginId}/${entry}`;

  const push = () => {
    const c = ctxRef.current;
    ref.current?.contentWindow?.postMessage(
      { t: "ctx", path: c.path, kind: c.kind, theme: document.documentElement.dataset.theme ?? null }, "*");
  };

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      /* ⚠️ **认证只能靠 `event.source`。**
         沙箱不给 `allow-same-origin`，所以插件那个 document 是**不透明源**，
         `e.origin` 永远是字符串 `"null"` —— 拿它做判断等于放行所有不透明源的窗口
         （页面上任何一个沙箱 iframe 都能冒充）。比对窗口对象才是准的。 */
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = e.data as FromPlugin;
      if (!m || typeof m !== "object") return;
      const reply = (id: number, payload: unknown) =>
        ref.current?.contentWindow?.postMessage({ t: "reply", id, payload }, "*");

      /* ⚠️ **必须处理 `ready`**：插件加载完之前，我们推的 context 会落空 ——
         `postMessage` 不排队，窗口里还没有监听器时发过去就没了。
         症状是「插件框出来了，但里面一直是『读取中…』」，看着像插件写错了。
         M11-5 当场栽过。 */
      if (m.t === "ready") { push(); return; }
      if (m.t === "toast") { toast(m.title, m.body, m.level ?? "ok"); return; }
      if (m.t === "menu") {
        /* 菜单由**宿主**画：插件只给数据，点了哪一项回给它一个下标。
           这样它的形制跟着主程序走，也不会被矩形裁掉。 */
        setMenu({ id: m.id, x: m.x, y: m.y, items: m.items.map((it, i) => ({
          label: it.label, hint: it.hint, danger: it.danger,
          run: it.disabled ? undefined : () => { setMenu(null); reply(m.id, i); },
        })) });
        return;
      }
      if (m.t === "call") {
        /* 插件要读写文件 —— 走 `plugin_call`，**服务端按它的清单核权限**。
           前端在这里只是个传声筒，不替它做任何判断：判断放前端就等于
           「把门锁挂在门外面」，插件改不了服务端，但改得了页面。 */
        const out = await ctx.core.post("plugin_call", { plugin: pluginId, cap: m.cap, input: m.input });
        reply(m.id, out);
        return;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [ctx.core, pluginId]);

  /* 上下文变了就推给插件（当前文件、主题）。**插件不能自己去问** —— 它没有网络 */
  useEffect(() => { push(); }, [ctx.path, ctx.kind]);

  return (
    <div className="flex-1 min-w-0 relative bg-canvas">
      <iframe
        ref={ref}
        /* ⚠️ **不给 `allow-same-origin`** —— 给了就退回普通 iframe，隔离没了。
           `allow-scripts` + 不给 same-origin = 不透明源：读不到父页面 DOM、
           读不到 localStorage，父页面也读不到它的 contentDocument（实测见 `doc/20` §3.3）。
           网络那一半靠服务端下的 CSP 响应头挡，两样缺一不可。 */
        sandbox="allow-scripts"
        src={src}
        title={`插件 ${pluginId}`}
        onLoad={() => setDead(null)}
        onError={() => setDead("插件页面加载失败")}
        className="w-full h-full border-0 block"
      />
      {dead && <div className="absolute inset-0 grid place-items-center text-xs text-muted bg-canvas">{dead}</div>}
      {menu && (
        <PopoverAt x={menu.x} y={menu.y} onClose={() => setMenu(null)} tag="pluginmenu">
          <div>
            {menu.items.map((mi, k) => mi.label === "—"
              ? <PopSep key={k} />
              : <PopItem key={k} label={mi.label} hint={mi.hint} danger={mi.danger} onPick={mi.run} />)}
          </div>
        </PopoverAt>
      )}
    </div>
  );
}
