import { z } from "zod";
import { envelope } from "../envelope.js";
import { deleteChat, listChats, loadChat, renameChat, setChatChannel } from "../chat.js";
import { getAiConfig, setAiConfig } from "../ai_config.js";
import { defineCap } from "./registry.js";
import type { CapCtx } from "./types.js";

/** 会话与 AI 配置（M11-7 第六批，最后一批）。
 *
 *  ⚠️ **这一域里三条留在手写路径**，理由和 §94.1 是同一条：
 *
 *  | 路由 | 为什么 |
 *  | --- | --- |
 *  | `chat_send` | 有**作业化**分支（`async: true` 时立刻回 jobId，界面边轮询边可中断，`00` §四十）。同一条路由两种返回形状，分发器只认信封 |
 *  | `chat_status` | 轮询那一半 |
 *  | `chat_interrupt` | 中断句柄（`AbortController`）活在 `api.ts` 的进程级 Map 里，跟着作业走 |
 *
 *  ⚠️ **密钥这条纪律两侧都守住了**：HTTP 的 `ai_config` 和 MCP 的 `get_ai_config`
 *  都只报「设没设」不回显 key（`11` Q7：密钥属于机器）。搬过来之后仍然只有一份掩码逻辑。
 */
const p = (c: CapCtx) => c.project!;

defineCap({
  name: "list_chats", title: "列出会话", scope: "project",
  summary: "按时间倒序列这个项目的会话。**空会话不算数** —— 会话是点「＋」就建的，真发出第一条消息才进列表。",
  input: {},
  http: { route: "chat_list", method: "GET" },
  run: async (_i, c) => {
    const r = await listChats(p(c).dir);
    /* **空会话不进列表**（设计侧第六轮定的规矩）：不滤的话，用户每点一次「＋」
       列表里就多一条空壳，很快被占满。**这里滤的是显示，盘上的文件不动** ——
       删文件是另一回事，得用户说了算。 */
    const sessions = r.sessions.filter((x) => x.msgCount > 0);
    return envelope({ sessions }, [], { count: sessions.length, total: r.sessions.length });
  },
});

defineCap({
  name: "get_chat", title: "读一个会话的全文", scope: "project",
  summary: "消息、工具行、用量都在里面。界面在作业跑的时候轮询它看工具行一条条长出来。",
  input: { session: z.string().describe("会话 ID") },
  http: { route: "chat_get", method: "GET" },
  run: async ({ session }, c) => {
    const s = await loadChat(p(c).dir, session);
    if (!s) throw new Error(`没有这个会话：${session}`);
    return envelope(s, [], { messages: s.messages?.length ?? 0 });
  },
});

defineCap({
  name: "rename_chat", title: "给会话改名", scope: "project",
  summary: "改标题。不给标题就是清掉（回到按首句自动取名）。",
  input: { session: z.string(), title: z.string().optional() },
  http: { route: "chat_rename", method: "POST" },
  run: async ({ session, title }, c) => {
    const s = await renameChat(p(c).dir, session, String(title ?? ""));
    return envelope({ id: s.id, title: s.title ?? "", titled: !!s.title });
  },
});

defineCap({
  name: "set_chat_channel", title: "改这一条会话走哪条通道", scope: "project",
  summary: "**只改这一条会话**；以后回到它还是这个通道（`11` Q33）。a = 直连按量 · b = 本地 CLI · c = 订阅。",
  input: {
    session: z.string(),
    channel: z.enum(["a", "b", "c"]),
    tool: z.string().optional().describe("通道 B 时用哪个本地 CLI"),
  },
  http: { route: "chat_channel", method: "POST" },
  run: async ({ session, channel, tool }, c) => {
    const s = await setChatChannel(p(c).dir, session, channel, tool);
    return envelope({ id: s.id, channel: s.channel, tool: s.tool ?? null });
  },
});

defineCap({
  name: "delete_chat", title: "删掉一个会话", scope: "project",
  summary: "真删这个会话的文件。**已落盘的改动不受影响** —— 那些在稿的版本历史里，会话只是对话记录。",
  input: { session: z.string() },
  http: { route: "chat_delete", method: "POST" },
  run: async ({ session }, c) => envelope(await deleteChat(p(c).dir, session)),
});

defineCap({
  name: "get_ai_config", title: "获取 AI 配置", scope: "global",
  summary: "通道的端点与模型名。⚠️ **密钥不回显**，只报设没设（`11` Q7：密钥属于机器，不属于项目）。",
  input: {},
  /* HTTP 侧的 `ai_config` 还要报「吃不吃图」「通道 B 是本机登录还是自配端点」等
     一大堆界面要的东西，**留在手写路径** —— 它的组装逻辑比这件本身长得多，
     搬过来只会让这份声明被一段界面专用的拼装淹掉。
     ⚠️ 两边都不回显 key，这条纪律没有因为分成两处而松。 */
  faces: ["mcp"],
  run: async () => {
    const cfg = await getAiConfig();
    const mask = (x: { baseUrl: string; apiKey: string; model: string } | null | undefined) =>
      x ? { baseUrl: x.baseUrl, apiKeySet: !!x.apiKey, model: x.model } : null;
    return envelope({ channelA: mask(cfg.channelA), channelB: mask(cfg.channelB), defaultChannel: cfg.defaultChannel });
  },
});

defineCap({
  name: "probe_image_support", title: "探一条通道吃不吃图", scope: "global",
  summary: [
    "发一张 1×1 的图试试。**别按模型名猜**（`11` Q32）——",
    "实测过 `deepseek-chat` 是能看图的，而按名字谁都会猜它不能（`00` §六十一之一）。",
  ].join("\n"),
  input: { channel: z.enum(["a", "c"]).optional().describe("探哪条通道，默认 a") },
  http: { route: "ai_probe_image", method: "POST" },
  run: async ({ channel }) => {
    const { probeImageSupport } = await import("../ai_probe.js");
    return envelope(await probeImageSupport(channel ?? "a"));
  },
});

defineCap({
  name: "list_local_clis", title: "扫本机装了哪些 AI CLI", scope: "global",
  summary: [
    "claude / cursor-agent / codex / gemini / opencode。**走登录态不是 API key** —— 用户已付的订阅能直接用上（`11` Q35）。",
    "⚠️ 返回里的 `verified` 只在**真机跑通过**才是 true。按文档写的适配器一律 false（`00` §65.6：codex 那三个字段实测全是错的）。",
  ].join("\n"),
  input: {},
  http: { route: "local_clis", method: "GET" },
  run: async () => {
    const { detectLocalClis } = await import("../local_cli.js");
    const rows = await detectLocalClis();
    return envelope({ clis: rows, installed: rows.filter((r) => r.installed).length }, [], { count: rows.length });
  },
});

defineCap({
  name: "list_cli_models", title: "问一个本地 CLI 有哪些模型", scope: "global",
  summary: "不同 CLI 的模型名不一样（claude 是 sonnet/opus，codex 是别的一套）。",
  input: { cli: z.string() },
  http: { route: "local_cli_models", method: "GET" },
  run: async ({ cli }) => {
    const { listCliModels, CLI_SPECS } = await import("../local_cli.js");
    if (!CLI_SPECS.some((x) => x.id === cli)) {
      throw new Error(`不认识的 CLI：${cli}（能选的是 ${CLI_SPECS.map((x) => x.id).join(" / ")}）`);
    }
    return envelope(await listCliModels(cli));
  },
});
