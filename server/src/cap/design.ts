import { z } from "zod";
import { envelope } from "../envelope.js";
import { getComponent, getIcon, getToken, listComponents, listIcons, searchTokens } from "../assets.js";
import { listCssVars } from "../cssvars.js";
import { globalSearch } from "../search.js";
import { setTokenValue } from "../token_edit.js";
import { defineCap } from "./registry.js";
import type { CapCtx } from "./types.js";

/** 设计系统（M11-7 第二批）。tokens / 图标 / 组件 / 全局搜索。
 *
 *  这一组的调用方很集中：`ui/S5-设计系统浏览器.dc.html` 一个稿就用掉了
 *  `tokens` / `icons` / `components` 三条。
 *  ⚠️ 所以改这一组的路由名之前先看 S5 —— `captest` 会替你查，但别指望它是唯一的闸。
 */
const p = (c: CapCtx) => c.project!;

defineCap({
  name: "search_tokens", title: "搜 tokens", scope: "project",
  summary: "按路径片段或取值片段搜。**不要试图取全量** —— tokens 有 1,200+ 个叶子，全取会把上下文撑爆。",
  input: {
    query: z.string().describe("路径片段或取值片段，如 danger / #E8590C / 行高"),
    limit: z.number().int().min(1).max(200).optional(),
  },
  /* HTTP 侧叫 `tokens`，S5 在用 */
  http: { route: "tokens", method: "GET" },
  run: async ({ query, limit }, c) => {
    const r = await searchTokens(p(c), query ?? "", limit ?? 30);
    return envelope({ query, hits: r.hits }, [], { total: r.total, returned: r.hits.length, truncated: r.truncated });
  },
});

defineCap({
  name: "get_token", title: "取一个 token 的值", scope: "project",
  summary: "按点号路径取。给中间节点（如 color.light）会返回它下面的全部叶子。",
  input: { path: z.string().describe("点号路径，如 color.light.bg 或 color.light") },
  http: { route: "token", method: "GET" },
  run: async ({ path }, c) => envelope(await getToken(p(c), path)),
});

defineCap({
  name: "set_token_value", title: "改一个 token 的取值", scope: "project",
  summary: "改设计系统里的取值。**会影响所有用到它的稿** —— 返回里带受影响的稿数，改之前心里有数。",
  input: {
    path: z.string().describe("token 的点号路径，如 color.light.danger"),
    value: z.string().describe("新取值（字符串）"),
  },
  http: { route: "token_set", method: "POST" },
  run: async ({ path, value }, c) => {
    const r = await setTokenValue(p(c), path, value);
    return envelope(r, [], { affected: r.affectedDrafts });
  },
});

defineCap({
  name: "list_icons", title: "列图标", scope: "project",
  summary: "按名字片段搜图标。默认**不带 svg path**（60 个图标的 path 很大）—— 要画出来时才带。",
  input: {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(300).optional(),
    withPath: z.boolean().optional().describe("带上 svg path。界面要画图标时用；只是想知道有哪些就不用"),
  },
  http: { route: "icons", method: "GET" },
  run: async ({ query, limit, withPath }, c) => {
    /* ⚠️ **默认值按门面分**，这是 `via` 存在的理由之一：
       界面**必须**有 path 才画得出图标；MCP 那边 60 个 path 是白占上下文，
       真要某一个用 `get_icon`。以前这个差别藏在 HTTP 那一行多传的 `true` 里，
       MCP 侧完全不知道有这回事。 */
    const want = withPath ?? c.via === "http";
    const r = await listIcons(p(c), query, limit ?? 60, want);
    return envelope({ viewBox: r.viewBox, icons: r.icons }, [], { total: r.total, truncated: r.truncated, withPath: want });
  },
});

defineCap({
  name: "get_icon", title: "取一个图标", scope: "project",
  summary: "按名字取一个图标的 svg path 与 viewBox。",
  input: { name: z.string() },
  http: { route: "icon", method: "GET" },
  run: async ({ name }, c) => envelope(await getIcon(p(c), name)),
});

defineCap({
  name: "list_components", title: "列组件", scope: "project",
  summary: "看有什么能复用。要复用就接着 get_component(mode:'contract') 拿它的 props 契约。",
  input: {},
  http: { route: "components", method: "GET" },
  run: async (_i, c) => {
    const list = await listComponents(p(c));
    return envelope({ total: list.length, components: list }, [], {
      total: list.length, withProps: list.filter((x) => x.props.length > 0).length,
    });
  },
});

defineCap({
  name: "get_component", title: "看一个组件怎么用", scope: "project",
  summary: "`contract` 只给 props 契约（省上下文，够用来调用它）；`full` 连实现一起给（要改它时才用）。",
  input: { name: z.string(), mode: z.enum(["contract", "full"]).optional() },
  http: { route: "component", method: "GET" },
  run: async ({ name, mode }, c) => envelope(await getComponent(p(c), name, mode ?? "contract")),
});

defineCap({
  name: "global_search", title: "全项目搜", scope: "project",
  summary: "搜 token 名、组件名、任意文案。找「这个东西还有谁在用」时比逐份稿看快得多。",
  input: {
    query: z.string().describe("搜索词，如 token 名 / 组件名 / 任意文案"),
    limit: z.number().int().min(1).max(500).optional().describe("最大返回条数，默认 100"),
  },
  http: { route: "search", method: "GET" },
  run: async ({ query, limit }, c) => {
    const r = await globalSearch(p(c), query, limit ?? 100);
    return envelope({ hits: r.hits }, [], { total: r.hits.length });
  },
});

defineCap({
  name: "list_css_vars", title: "列一份 CSS 里的变量", scope: "project",
  summary: "给属性面板挑变量用：读一个 css 文件里定义了哪些自定义属性。",
  input: { file: z.string().describe("css 文件相对项目根的路径"), query: z.string().optional() },
  /* ⚠️ **只给 HTTP**：它是界面的取值辅助（在属性面板里挑一个变量）。
     模型那边要知道有哪些取值应该用 `search_tokens` —— 那才是设计系统的正源，
     css 变量只是它渲染出来的一层。两边都给的话，模型会从错的那一层取值。 */
  faces: ["http"],
  http: { route: "cssvars", method: "GET" },
  run: async ({ file, query }, c) => envelope(await listCssVars(p(c), file, query, 200)),
});
