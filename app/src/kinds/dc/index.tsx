import { HEALTH_LABEL } from "../../api/types";
import { SidePanels } from "../../workbench/SidePanels";
import type { ViewContext } from "../context";
import type { KindModule } from "../registry";
import { Seg, SizeBtn } from "../toolbar";
import { Glyph, ICON } from "../../ui/Glyph";
import { DcProvider, PRESETS, useDc } from "./bridge";
import { DcView } from "./View";

export type { PreviewMode } from "./bridge";

/** `.dc.html` 设计稿 —— 这个工具最深的一种类型（`01` §1）。
 *
 *  它是唯一同时用到全部六样声明的格式：画布、五个从属面板、自己的 `⋯`、
 *  状态行读数、一条工具栏，以及一份跨位置共享的状态（那座 postMessage 桥，见 `bridge.tsx`）。
 *  别的格式简单得多 —— 这是「基础设施按最复杂的那一种设计，简单的自然装得下」。
 */
const ZOOMS = [0.3, 0.5, 0.75, 1, 1.25, 1.5];

function Toolbar({ ctx }: { ctx: ViewContext }) {
  const d = useDc();
  const edit = d.mode === "shell";
  /* 详情挤不下时，**先收「演示」**：它和「体检」一样是低频动作，收进 `⋯` 照样点得到；
     而视图组、指针、尺寸是看稿时一直在用的。
     不收的话 `⋯` 会被挤出可视区（M8-24 量出来：详情 440 时它落在 1067，可视区到 1060）。 */
  const roomy = ctx.detail >= 560;
  return (
    <>
      <Seg label="视图" items={[
        { label: "编辑", active: d.mode === "shell", onPick: () => d.setMode("shell"), title: "编辑：能点选、改属性、钉评论" },
        { label: "预览", active: d.mode === "raw", onPick: () => d.setMode("raw"), title: "预览：稿本身，可以点里面的交互" },
        { label: "源码", active: d.mode === "code", onPick: () => d.setMode("code"), title: "源码：只读" },
      ]} />
      {/* 指针组只在编辑态出现（第七轮的裁决）。
          ⚠️ **只有「点选」一半** —— 第七轮还画了「评论」指针，但 S2 嵌入壳现在只认
          `pick / preset / zoom / theme` 这几条命令，没有钉评论那一条。
          钉评论目前还走右侧的评论面板。要补的是 S2 稿的接线，记在 `doc/12` M8-15b 的遗留里。 */}
      {edit && (
        <div role="group" aria-label="指针" className="flex items-center gap-0.5 p-0.5 bg-panel2 border border-border rounded shrink-0">
          <button onClick={() => d.cmd("pick")} aria-pressed={d.shell.selectOn}
            title="点选：点稿里的元素即选中（V）。再点一次关掉，回到操作稿"
            className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm ${d.shell.selectOn ? "bg-accentSoft text-accent font-semibold" : "text-text2 hover:text-text"}`}>
            <Glyph d={ICON.pointer} size={12} />点选
          </button>
        </div>
      )}
      <span className="flex-1" />
      {/* `✽` 稿的浅 / 深色：**一颗独立开关**，放在宽度·缩放钮左边（第八轮 §八）。
          设计侧特意说了它**不进**那个弹层：弹层回答的是「稿在屏上多大」，
          浅深回答的是「稿长什么样」；也**不进** `⋯`：看深色版本是常做的事，
          而且需要来回切着对比。 */}
      {edit && (
        <button onClick={() => d.cmd("theme", d.shell.draftTheme === "dark" ? "light" : "dark")}
          aria-pressed={d.shell.draftTheme === "dark"} data-ud="draft-theme"
          title="稿的浅 / 深色 —— 只改这份稿怎么显示，不改工具外观"
          className={`w-[26px] h-[22px] grid place-items-center rounded-sm shrink-0 border ${
            d.shell.draftTheme === "dark" ? "bg-accentSoft text-accent border-accent" : "bg-panel2 text-text2 border-border hover:text-text"}`}>
          <Glyph d={ICON.halfTone} size={13} />
        </button>
      )}
      {edit && (
        <SizeBtn
          label={`${PRESETS[d.shell.preset] ?? "自适应"} · ${Math.round(d.shell.zoom * 100)}%`}
          title="画布宽度与缩放"
          widths={PRESETS.map((label, i) => ({ label, px: label.match(/\d+/)?.[0] ?? "—", on: d.shell.preset === i, pick: () => d.cmd("preset", i) }))}
          zoomPct={Math.round(d.shell.zoom * 100)}
          onZoom={(dir) => d.cmd("zoom", dir > 0 ? (ZOOMS.find((z) => z > d.shell.zoom) ?? 1.5) : (ZOOMS.filter((z) => z < d.shell.zoom).pop() ?? 0.3))}
          onFit={() => d.cmd("zoom", 1)} />
      )}
      {roomy && <button className="btn sm shrink-0" onClick={() => d.setPresent(true)} title="全屏只看稿，Esc 退出">▷ 演示</button>}
    </>
  );
}

function View({ ctx }: { ctx: ViewContext }) {
  return <DcView store={ctx.store} picked={ctx.picked} />;
}

function Panels({ ctx }: { ctx: ViewContext }) {
  return (
    <SidePanels core={ctx.core} store={ctx.store} file={ctx.path} picked={ctx.picked} onPicked={ctx.setPicked}
      panels={[...(dc.panels ?? [])]} active={ctx.ui.activePanel} setActive={ctx.ui.openPanel} narrow={ctx.narrow}
      onSendToAI={(text, p) => { ctx.setPicked(p); ctx.ask(text); }} outline={[]} />
  );
}

function Status({ ctx }: { ctx: ViewContext }) {
  const d = ctx.store.drafts.find((x) => x.file === ctx.path);
  if (!d) return <span>设计稿</span>;
  return (
    <>
      <span>{d.kind === "component" ? "组件稿" : "设计稿"}</span>
      <span>·</span><span>{d.version ?? "—"}</span>
      <span>·</span><span>{d.elements ?? "—"} 元素</span>
      <span>·</span><span title={d.healthWhy}>{HEALTH_LABEL[d.health]}</span>
    </>
  );
}

/** `⋯` 里这四项都是低频动作。体检收进来是第七轮的裁决，它给的理由好：
 *  「结果本来就常驻在诊断角标、状态行、树里的点上，常驻一颗钮只为手动重跑，那是低频」。 */
function menu(ctx: ViewContext) {
  const checking = ctx.store.checking === ctx.path;
  return [
    /* 窄的时候演示从工具栏收到这儿来 —— 它没消失，只是换了个够得着的地方 */
    ...(ctx.detail < 560 ? [{ label: "演示（全屏只看稿）", run: () => window.dispatchEvent(new CustomEvent("ud-dc-present")) }] : []),
    { label: checking ? "体检中…" : "重新体检", hint: checking ? "" : "手动重跑", run: () => void ctx.store.runCheck(ctx.path) },
    { label: "对比上一版", hint: "S6", run: () => window.open(`${ctx.project.url}${encodeURIComponent("S6-版本对比.dc.html")}?file=${encodeURIComponent(ctx.path)}`, "_blank") },
    { label: "重新加载预览", run: () => window.dispatchEvent(new CustomEvent("ud-dc-reload")) },
    { label: "在浏览器中打开", run: () => void ctx.host.openExternal(`${ctx.project.url}${encodeURIComponent(ctx.path).replace(/%2F/g, "/")}`) },
  ];
}

export const dc: KindModule = {
  ids: ["dc"],
  panels: ["props", "diagnostics", "changes", "comments", "info"],
  Provider: DcProvider,
  View, Toolbar, Panels, Status, menu,
};
