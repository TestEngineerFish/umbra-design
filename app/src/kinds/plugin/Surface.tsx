import { useEffect, useRef, useState } from "react";
import { toast } from "../../ui/Toast";
import { dirtyStore } from "../../ui/dirty";
import { PopoverAt, PopItem, PopSep } from "../../ui/Popover";
import { chromeKey, dropChrome, setChrome, setSender } from "./chrome";
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
  | { t: "toast"; title: string; body?: string; level?: "ok" | "error" }
  /** 插件把它的 chrome（编辑栏 / 状态 / 菜单）**交给宿主画**。全量覆盖，不是增量 */
  | { t: "chrome"; toolbar?: unknown; buttons?: unknown; status?: string; menu?: unknown }
  /** 同一个插件的几个 frame 之间互通（正文 ⇄ 面板）。宿主只转发，不看内容 */
  | { t: "share"; key: string; value: unknown }
  /** 有没有没落盘的改动。关页签要拦，所以这件归宿主管 */
  | { t: "dirty"; on: boolean }
  /** 把一段文字带进会话（「选中这段给 AI」） */
  | { t: "ask"; text: string };

export function PluginSurface({ ctx, pluginId, entry, role = "body" }: {
  ctx: ViewContext; pluginId: string; entry: string;
  /** `body` = 详情区正文；`panel` = 属性区里的一个面板。
   *  两者共用这一份宿主，区别只在**谁来管 chrome**（面板不管）。 */
  role?: "body" | "panel";
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number; items: MenuItem[] } | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  /* 最新的上下文放 ref 里：插件 `ready` 的时机不定，到时候要拿当场的值推给它。
     直接闭包捕获的话拿到的是挂载那一刻的旧值。 */
  const ctxRef = useRef({ path: ctx.path, kind: ctx.kind });
  ctxRef.current = { path: ctx.path, kind: ctx.kind };
  const src = `${ctx.core.url.replace(/\/$/, "")}/__plugin/${pluginId}/${entry}`;
  const key = chromeKey(pluginId, ctx.path);

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
      if (m.t === "chrome") {
        /* 只有正文那一个 frame 能设 chrome —— 面板也能设的话，
           两个 frame 会互相覆盖，而症状是「编辑栏时有时无」。 */
        if (role === "body") setChrome(key, m as never);
        return;
      }
      if (m.t === "share") {
        /* 同一个插件的几个 frame 互通。**宿主只转发，不看内容** ——
           看内容就等于在宿主里维护插件的数据模型，那是插件自己的事。
           只转给**同一个插件**的 frame（按 name 前缀认），不会串到别的插件去。 */
        for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>(`iframe[data-plugin="${CSS.escape(pluginId)}"]`))) {
          if (f.contentWindow && f.contentWindow !== e.source) f.contentWindow.postMessage({ t: "share", key: m.key, value: m.value }, "*");
        }
        return;
      }
      if (m.t === "toast") { toast(m.title, m.body, m.level ?? "ok"); return; }
      /* 未落盘状态归宿主管：关页签要拦、退出要拦，这些都发生在插件的矩形之外 */
      if (m.t === "dirty") { dirtyStore.set(ctx.path, m.on); return; }
      if (m.t === "ask") { ctx.ask(m.text); return; }
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
    /* chrome 上被点了什么，回给插件。`Workbench` 画的按钮最终走到这儿 */
    if (role === "body") {
      setSender(key, (kind, a, b) =>
        ref.current?.contentWindow?.postMessage({ t: "chrome-hit", kind, a, b }, "*"));
    }
    return () => {
      window.removeEventListener("message", onMsg);
      /* 换文件 / 卸载时把这份 chrome 收掉 —— 不收的话编辑栏会停在上一个文件的状态 */
      if (role === "body") dropChrome(key);
    };
  }, [ctx.core, pluginId, key, role]);

  /* 上下文变了就推给插件（当前文件、主题）。**插件不能自己去问** —— 它没有网络 */
  useEffect(() => { push(); }, [ctx.path, ctx.kind]);
  /* 文件在盘上变了（AI 改的、别的编辑器改的）要告诉插件重读。
     **插件自己发现不了** —— 它没有文件系统也没有事件流。
     不推的话症状是「AI 改完了，右边还是旧的」（2026-09-24 用户实测过同类）。 */
  const tick = ctx.store.fileTick(ctx.path);
  useEffect(() => {
    if (!tick) return;
    ref.current?.contentWindow?.postMessage({ t: "changed", path: ctx.path }, "*");
  }, [tick, ctx.path]);
  /* 换文件 / 卸载时把未落盘标记清掉 —— 留着的话关页签会一直被拦 */
  useEffect(() => () => { dirtyStore.set(ctx.path, false); }, [ctx.path]);

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
        data-plugin={pluginId}
        /* 结构标记：正文和面板是两个 iframe，判据要指得准
           （M11-9a 栽过：`iframe[title^="插件"]` 在面板打开后匹配到两个） */
        data-role={role}
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
