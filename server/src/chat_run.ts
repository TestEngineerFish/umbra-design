/** AI 会话的执行主体（M2）：agent 循环里的工具执行 + chat_send 的完整流程。
 *  抽出来是为了让 MCP 工具（index.ts）和本地 API（api.ts，应用前端的会话面板走它）共用同一份 ——
 *  两个入口一套逻辑，落盘仍走唯一写入口（01 H3）。 */
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { envelope, toContent, ToolError, err, type Envelope } from "./envelope.js";
import { X } from "./codes.js";
import {
  TOOL_ROOT, buildProject, createProject, createDraft, duplicateDraft, createFolder,
  updateProject, archiveProject, deleteProject,
  draftPath, listDrafts, listProjectDirs, loadProject, projectsRoot,
  type Project,
} from "./project.js";
import { getComponent, getIcon, getToken, listComponents, listIcons, searchTokens } from "./assets.js";
import { validateDraft } from "./validate.js";
import { patchDraft, writeDraft } from "./write.js";
import { missingRuntime } from "./normalize.js";
import { getAiConfig, setAiConfig, channelSupportsImage, getChannelA, getChannelB, getOpenAiChannel, looksLikeQuotaProblem, type AiConfig } from "./ai_config.js";
import { chat, type ToolDef, type ToolCall, type ChatMessage } from "./provider.js";
import { createChat, loadChat, saveChat, listChats, deleteChat, addMessage, type ChatSession, type ChatEntry } from "./chat.js";
import { findBrowser, renderCheck } from "./render.js";
import { runLocalCli, specOf } from "./local_cli.js";
import {
  changesSince, diffDrafts, listVersions, projectChangesSince, readSnapshot,
  resolveSnapshot, toMarkdown,
} from "./history.js";
import { serveStart, serveStatus, serveStop } from "./serve.js";
import { buildIndex, collectIndex } from "./indexpage.js";
import { locateNode } from "./locate.js";
import { listFiles, moveFile, readAnyFile, writeAnyFile } from "./files.js";
import { revertTo, setProp } from "./edit.js";
import { touchProject, listRecentProjects, removeRecentProject, clearRecentProjects } from "./workspace.js";
import { buildRefGraph, listReferences, renameDraft, moveDraft, deleteDraft, deleteDraftImpact, listTrash, restoreDraft } from "./refs.js";
import { globalSearch } from "./search.js";
import { setTokenValue } from "./token_edit.js";
import { listTemplates, saveAsTemplate, deleteTemplate } from "./templates.js";
import { exportProject, importProject } from "./export.js";

/* 与 index.ts 的 GUIDES 同一张表（写稿规则文档索引）。不从 index.ts 引 —— 那会形成循环导入。 */
const GUIDES: Record<string, { file: string; note: string }> = {
  template: { file: "03-渲染与交互逻辑.md", note: "模板语言的精确语义（框架语义，与项目无关）" },
  logic: { file: "03-渲染与交互逻辑.md", note: "逻辑类契约与渲染时序" },
  interaction: { file: "06-写稿规则.md", note: "本项目的写法约定（交互、规模、收尾）" },
  checklist: { file: "06-写稿规则.md", note: "开工前与收尾的自检" },
  tokens: { file: "06-写稿规则.md", note: "取值从哪来、@ds 别名怎么写" },
};

export interface ChatSendArgs {
  message: string;
  sessionId?: string;
  channel?: "a" | "b" | "c";
  selectedNodeFile?: string;
  selectedNodeAddress?: string;
  /** 目录视图里选中的若干文件（M8-4，`01` 第 32 条）。路径相对项目根 */
  selectedFiles?: string[];
  /** `.md` 里选中的一段（M8-8，`01` 第 30 条）：label 是「路径 L9-12」，text 是那一段原文 */
  selectedRange?: { label: string; text: string };
  /** 图片上圈的一块（M8-10，`01` 第 31 条）：坐标一句话 + 备注 + 裁出来那块的 data URL */
  selectedRegion?: { label: string; note: string; image: string | null };
  /** 应用前端里当前正在看的稿（没选中节点时的弱上下文）：进系统提示，不进用户那句 */
  contextFile?: string;
  /** 作业化调用时的中断信号（本地 API chat_interrupt 触发）：通道 A 的 agent 循环在下一步前停下 */
  abortSignal?: AbortSignal;
}

/** agent 循环中真正执行一个工具调用。返回 JSON 字符串给模型。 */
export async function executeToolCall(p: Project, tc: ToolCall): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    return JSON.stringify({ ok: false, error: `参数解析失败: ${tc.function.arguments.slice(0, 200)}` });
  }

  try {
    switch (tc.function.name) {
      // ── 项目/稿件读取 ──
      case "get_project": {
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        return JSON.stringify({
          ok: true,
          name: p.name, title: p.title, dir: p.dir,
          designSystem: p.config.designSystem ? { dir: p.dsDir, alias: p.dsAlias } : null,
          tokens: p.config.tokens ?? null, icons: p.config.icons ?? null,
          limits: p.limits, gitEnabled: p.gitEnabled,
          drafts,
        });
      }
      case "list_drafts": {
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        return JSON.stringify({ ok: true, drafts });
      }

      /* ── 泛型文件（M8）。设计稿之外的东西走这四件；`.dc.html` 在 write_file / move_file 里会被拒。
         少了它们，AI 面对 `.md` 只会一路撞 patch_draft 的「文件名必须以 .dc.html 结尾」【实测 2026-09-24】。 ── */
      case "list_files": {
        const r = await listFiles(p, String(args.dir ?? ""));
        return JSON.stringify({ ok: true, dir: r.dir, types: r.types,
          entries: r.entries.map((e) => ({ path: e.path, kind: e.kind, isDir: e.isDir, size: e.size, snapshot: e.snapshot ?? null })) });
      }
      case "read_file": {
        const r = await readAnyFile(p, String(args.path ?? ""));
        return JSON.stringify({ ok: true, path: r.path, kind: r.kind, size: r.size, sha256: r.sha256,
          snapshot: r.snapshot ?? null, content: r.content, why: r.why ?? null,
          note: r.content === null ? "这是二进制或超限文件，没有正文" : "改它之前把 sha256 原样带回 write_file" });
      }
      case "write_file": {
        const r = await writeAnyFile(p, String(args.path ?? ""), String(args.content ?? ""),
          { expectSha256: typeof args.expectSha256 === "string" ? args.expectSha256 : undefined, origin: "AI", note: typeof args.note === "string" ? args.note : undefined });
        return JSON.stringify({ ok: true, path: r.path, snapshot: r.snapshot, previous: r.previous, bytes: r.bytes, sha256: r.sha256 });
      }
      case "move_file": {
        const r = await moveFile(p, String(args.from ?? ""), String(args.to ?? ""));
        return JSON.stringify({ ok: true, from: r.from, to: r.to, rewrote: r.rewrote });
      }

      // ── 设计系统检索 ──
      case "search_tokens": {
        const r = await searchTokens(p, args.query as string, (args.limit as number) ?? 30);
        return JSON.stringify({ ok: true, hits: r.hits.length, total: r.total, truncated: r.truncated });
      }
      case "get_token": {
        const r = await getToken(p, args.path as string);
        return JSON.stringify({ ok: true, ...r });
      }
      case "list_components": {
        const list = await listComponents(p);
        return JSON.stringify({ ok: true, components: list, total: list.length });
      }
      case "get_component": {
        const r = await getComponent(p, args.name as string, (args.mode as "contract" | "full") ?? "contract");
        return JSON.stringify({ ok: true, ...r });
      }
      case "read_draft": {
        /* 模型要改稿，先得看见稿。2026-09-23 实测：DeepSeek 找不到 get_component(mode=full) 这条路，
           猜了三轮节点地址后放弃；给一个名字就叫「读稿」的工具，源码里自带 data-ud-node 地址，set_prop 直接用。 */
        const rel = args.path as string;
        const abs = draftPath(p, rel);
        const src = await readFile(abs, "utf8");
        const max = 60000;
        const nodes = (src.match(/data-ud-node="([^"]+)"/g) ?? []).length;
        return JSON.stringify({ ok: true, path: rel, bytes: src.length, nodeAddresses: nodes,
          note: "source 里每个元素的 data-ud-node 就是 set_prop / locate_node 要的 node 地址",
          truncated: src.length > max, source: src.slice(0, max) });
      }
      case "list_icons": {
        const r = await listIcons(p, args.query as string | undefined, (args.limit as number) ?? 60);
        return JSON.stringify({ ok: true, viewBox: r.viewBox, icons: r.icons, total: r.total });
      }
      case "get_icon": {
        const r = await getIcon(p, args.name as string);
        return JSON.stringify({ ok: true, ...r });
      }
      case "get_syntax_guide": {
        const topic = args.topic as string;
        const g = GUIDES[topic] as { file: string; note: string } | undefined;
        if (!g) return JSON.stringify({ ok: false, error: `未知 topic: ${topic}` });
        const text = await readFile(join(TOOL_ROOT, "doc", g.file), "utf8");
        return JSON.stringify({ ok: true, topic, note: g.note, source: `doc/${g.file}`, text: text.slice(0, 20000) });
      }

      // ── 校验与写入 ──
      case "validate_draft": {
        const path = args.path as string;
        const abs = draftPath(p, path);
        const src = await readFile(abs, "utf8");
        const { diags, stats } = validateDraft(p, path, src, path);
        return JSON.stringify({ ok: true, project: p.name, path, errors: diags.filter((d) => d.level === "error").length, warnings: diags.filter((d) => d.level === "warning").length, diags: diags.slice(0, 50), stats });
      }
      case "write_draft": {
        const path = args.path as string;
        const content = args.content as string;
        const kind = (args.kind as "page" | "component") ?? "page";
        const r = await writeDraft(p, path, content, kind);
        return JSON.stringify({ ok: r.outcome.written, outcome: r.outcome, stats: r.stats, errors: r.diags.filter((d) => d.level === "error").length });
      }
      case "patch_draft": {
        const path = args.path as string;
        const edits = args.edits as Array<{ old: string; new: string; count?: number }>;
        const r = await patchDraft(p, path, edits);
        return JSON.stringify({ ok: r.outcome.written, outcome: r.outcome, stats: r.stats, errors: r.diags.filter((d) => d.level === "error").length });
      }
      case "render_check": {
        const path = args.path as string;
        const r = await renderCheck(p, path, {
          width: args.width as number | undefined,
          height: args.height as number | undefined,
        });
        return JSON.stringify({
          ok: true, alive: r.result.alive, nodeCount: r.result.nodeCount,
          renderMs: r.result.renderMs,
          unresolvedHoles: r.result.unresolvedHoles.length,
          consoleWarnings: r.result.consoleWarnings?.length ?? 0,
          externalRequests: r.result.externalRequests.length,
        });
      }

      // ── 版本与变更 ──
      case "list_versions": {
        const path = args.path as string;
        const vs = await listVersions(p, path);
        return JSON.stringify({ ok: true, path, versions: vs, latest: vs[vs.length - 1] ?? null, count: vs.length });
      }
      case "diff_drafts": {
        const path = args.path as string;
        const from = args.from as string;
        const to = (args.to as string) ?? undefined;
        const d = await diffDrafts(p, path, { from, to });
        return JSON.stringify({ ok: true, path, from, to: to ?? "latest", counts: d.counts, changes: d.changes.slice(0, 100) });
      }
      case "snapshot_draft": {
        const path = args.path as string;
        const version = (args.version as string) ?? "工作区";
        const snap = await resolveSnapshot(p, path, version);
        return JSON.stringify({
          ok: true, path, version,
          nodes: snap.nodes.length, texts: snap.texts.length,
          tokensUsed: snap.tokensUsed.length, branches: snap.branches.length,
          props: snap.props,
        });
      }
      case "get_changes_since": {
        const since = args.since as string;
        const path = (args.path as string) ?? undefined;
        if (path) {
          const d = await changesSince(p, path, since);
          return JSON.stringify({ ok: true, path, since, counts: d.counts, changes: d.changes.slice(0, 100) });
        }
        const drafts = (await listDrafts(p)).map((a) => a.slice(p.dir.length + 1).split("\\").join("/"));
        const rows = await projectChangesSince(p, drafts, since);
        const changed = rows.filter((r) => r.diff && r.diff.changes.length > 0);
        return JSON.stringify({
          ok: true, since,
          draftsScanned: rows.length,
          draftsChanged: changed.length,
          drafts: changed.map((r) => ({ path: r.path, counts: r.diff?.counts })),
        });
      }
      case "revert_to": {
        const file = args.file as string;
        const version = args.version as string;
        const r = await revertTo(p, file, version);
        return JSON.stringify({ ok: true, written: r.write.written, newVersion: r.write.version, restored: r.restored });
      }

      // ── 节点定位与属性编辑 ──
      case "locate_node": {
        const file = args.file as string;
        const node = args.node as string;
        const r = await locateNode(p, file, node);
        return JSON.stringify({
          ok: true, file, node, line: r.at.line, col: r.at.col, tag: r.tag,
          slots: r.slots.map((s) => ({ kind: s.kind, name: s.name, value: s.value, editable: s.editable, note: s.note })),
          inList: r.inList,
        });
      }
      case "set_prop": {
        const file = args.file as string;
        const node = args.node as string;
        const kind = args.kind as "style" | "attr" | "text";
        const name = args.name as string;
        const value = args.value as string;
        const r = await setProp(p, file, node, kind, name, value);
        return JSON.stringify({
          ok: true, written: r.write.written, version: r.write.version,
          newNode: r.newNode, bytesDelta: r.write.bytes,
        });
      }

      // ── 引用图谱 ──
      case "list_references": {
        const file = args.file as string | undefined;
        const r = await listReferences(p, file);
        return JSON.stringify({ ok: true, file: r.file ?? null, imports: r.imports, importedBy: r.importedBy, overview: r.overview?.slice(0, 30) });
      }

      default:
        return JSON.stringify({ ok: false, error: `未实现的工具: ${tc.function.name}` });
    }
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    return JSON.stringify({ ok: false, error: `${tc.function.name} 执行失败: ${m}` });
  }
}

/** 续接会话时历史必须配得上对：每个 assistant.tool_calls 后面要跟齐全部 tool 结果（带 tool_call_id），
 *  否则 OpenAI 形状的端点会 4xx。修 toolCallId 落盘之前的旧会话里 tool 条目没有 id ——
 *  对这种条目：丢掉没 id 的 tool 消息，并把对不上结果的 tool_calls 从 assistant 里剥掉（保留文本）。 */
function sanitizeHistory(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as ChatMessage;
    if (m.role === "tool") { if (m.tool_call_id) out.push(m); continue; }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      const ids = new Set<string>();
      for (let j = i + 1; j < msgs.length && (msgs[j] as ChatMessage).role === "tool"; j++) {
        const id = (msgs[j] as ChatMessage).tool_call_id; if (id) ids.add(id);
      }
      const complete = m.tool_calls.every((tc) => ids.has(tc.id));
      if (!complete) { const { tool_calls: _drop, ...rest } = m; if (rest.content) out.push(rest as ChatMessage); continue; }
    }
    out.push(m);
  }
  return out;
}

/** chat_send：加载/新建会话 → 选中节点上下文 → 通道 A agent 循环或通道 B 子进程 → 审计变更。返回信封。 */
/** 系统提示里「看不看得了图」那一句的占位 —— 降级换通道时按新通道的能力重填 */
const IMAGE_NOTE_SLOT = "\u0000IMAGE_NOTE\u0000";
function imageNote(seeImage: boolean): string {
  return seeImage
    ? [
        "随这条消息发过去的**只有圈中的那一块**，不是整张图 —— 别拿它描述整张图长什么样。",
        "坐标是原图像素，原点在左上角：x 向右增大，y 向下增大。回答时引用坐标，别只说「这里」。",
      ].join("\n")
    : "**你看不到图**（当前通道不支持图片），只有坐标和他的话。别猜图上画的是什么；需要看图就直说「这个通道看不了图，换一个能看图的模型」。";
}
/** 换到看不了图的通道时，把已经挂上去的图片段去掉，只留文字 */
function stripImages(history: Array<{ content: unknown }>): void {
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    const text = (m.content as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("");
    m.content = text;
  }
}

export async function runChatSend(p: Project, a: ChatSendArgs): Promise<Envelope<any>> {
  const { message, sessionId, channel, selectedNodeFile, selectedNodeAddress, selectedFiles, selectedRange, selectedRegion, contextFile, abortSignal } = a;
  const cfgAll = await getAiConfig();
  const ch = channel ?? cfgAll.defaultChannel ?? "a";
  /** A 与 C 同形（OpenAI 兼容），走同一条 agent 循环；B 是 Claude Code 子进程 */
  const isOpenAiChannel = ch === "a" || ch === "c";

  // 加载或新建会话
  let session: ChatSession | null = sessionId ? await loadChat(p.dir, sessionId) : null;
  if (!session) {
    session = await createChat(p.dir, {
      projectId: p.name,
      channel: ch,
      model: (ch === "c" ? cfgAll.channelC?.model : ch === "b" ? cfgAll.channelB?.model : cfgAll.channelA?.model) ?? "unknown",
    });
  }

  // 用户消息写入会话 —— 要拿回更新后的会话对象：下面的 history 从它取，
  // 否则发给模型的只有 system 一条，用户那句根本不在（智谱直接 400「messages 参数非法」，2026-09-23 实测）
  session = await addMessage(p.dir, session.id, { role: "user", content: message });

  // ── 选中节点上下文（M2-8） ──
  let nodeContext: string | null = null;
  if (selectedNodeFile && selectedNodeAddress) {
    try {
      const loc = await locateNode(p, selectedNodeFile, selectedNodeAddress);
      const editableSlots = loc.slots.filter((s) => s.editable);
      nodeContext = [
        `【当前选中节点】`,
        `  稿: ${loc.file}`,
        `  节点地址: ${loc.node}`,
        `  标签: ${loc.tag}`,
        `  源码位置: 第 ${loc.at.line} 行第 ${loc.at.col} 列`,
        `  在 sc-for 循环中: ${loc.inList ? "是（改动会影响循环所有行）" : "否"}`,
        `  可编辑项 (${editableSlots.length} 个):`,
        ...editableSlots.slice(0, 15).map((s) => `    - ${s.kind}: ${s.name} = "${String(s.value).slice(0, 80)}"`),
        ...(editableSlots.length > 15 ? [`    ... 还有 ${editableSlots.length - 15} 个可编辑项`] : []),
      ].join("\n");
    } catch {
      // 节点地址可能已过期，静默忽略
    }
  }

  /* ── 选中文件上下文（M8-4）：给路径、类型、大小，外加文本的头几行。
     不把正文整份塞进系统提示 —— 模型有 read_file，要看自己去读；这里只保证它**知道是哪几个**。 ── */
  let filesContext: string | null = null;
  if (selectedFiles && selectedFiles.length) {
    const lines: string[] = [`【当前选中的文件】共 ${selectedFiles.length} 个`];
    for (const rel of selectedFiles.slice(0, 20)) {
      try {
        const info = await readAnyFile(p, rel);
        const head = info.content ? info.content.split("\n").slice(0, 3).map((x) => x.trim()).filter(Boolean).join(" / ").slice(0, 100) : "";
        lines.push(`  - ${rel}（${info.kind}，${info.size} 字节${info.width ? `，${info.width}×${info.height}` : ""}）${head ? ` — ${head}` : ""}`);
      } catch {
        // 目录不是「读不到」，它本来就不是文件 —— 说错了模型会以为出了故障
        try { const d = await listFiles(p, rel); lines.push(`  - ${rel}（目录，${d.entries.length} 项）`); }
        catch { lines.push(`  - ${rel}（读不到，可能刚被挪走）`); }
      }
    }
    if (selectedFiles.length > 20) lines.push(`  … 还有 ${selectedFiles.length - 20} 个`);
    filesContext = lines.join("\n");
  }

  /* ── 选中段落（M8-8）：给路径、行范围、原文。改的时候要**只改这一段** ── */
  let rangeContext: string | null = null;
  if (selectedRange?.text) {
    rangeContext = [`【当前选中的一段】${selectedRange.label}`, "```", selectedRange.text.slice(0, 4000), "```"].join("\n");
  }

  /* ── 图片圈选（M8-10）：坐标与备注一律发（文字通道也读得懂）；**图只在通道支持时发**。
     不支持还硬发，对面要么报错要么把 base64 当文本吞进去烧 token —— 两种都比说一句「这个通道看不了图」差。 ── */
  let canSeeImage = false;
  let regionContext: string | null = null;
  if (selectedRegion?.label) {
    regionContext = [`【用户在图上圈了一块】${selectedRegion.label}`, selectedRegion.note ? `他说：${selectedRegion.note}` : ""].filter(Boolean).join("\n");
  }

  // 通道 A / C：同一条 agent 循环，只是配置不同（C 是订阅额度那条，优先用）
  if (isOpenAiChannel) {
    let providerCfg = await getOpenAiChannel(ch as "a" | "c");
    canSeeImage = channelSupportsImage(providerCfg);

    // ── 记录循环前各稿的版本（用于审计变更） ──
    const draftVersionsBefore: Map<string, string> = new Map();
    try {
      const allDrafts = await listDrafts(p);
      for (const abs of allDrafts) {
        const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
        const vs = await listVersions(p, rel);
        if (vs.length > 0) draftVersionsBefore.set(rel, vs[vs.length - 1] as string);
      }
    } catch { /* 忽略，不影响主流程 */ }

    const history: ChatMessage[] = sanitizeHistory(session.messages.map((m) => ({
      role: m.role as ChatMessage["role"],
      content: m.content,
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId, name: m.toolName } : {}),
    })));

    // 工具定义：把我们现有的 MCP 工具暴露给模型
    const tools: ToolDef[] = [
      { type: "function", function: { name: "get_project", description: "取项目配置与稿清单", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "list_drafts", description: "列出项目所有稿", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "search_tokens", description: "按路径或取值模糊检索 token", parameters: { type: "object", properties: { project: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["project", "query"] } } },
      { type: "function", function: { name: "get_token", description: "取单个 token 全文", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "list_components", description: "列出所有组件与页稿", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_component", description: "取组件契约或全文", parameters: { type: "object", properties: { project: { type: "string" }, name: { type: "string" }, mode: { type: "string", enum: ["contract", "full"] } }, required: ["project", "name"] } } },
      { type: "function", function: { name: "read_draft", description: "读一份稿的源码（改稿前先读它）。返回的 HTML 里每个元素带 data-ud-node 地址，set_prop 就用这个地址", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string", description: "稿相对项目根的路径，如 测试.dc.html" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "list_files", description: "列一层目录里的所有文件（不只设计稿）。每项带 kind（dir/dc/md/image/code/html/other）、大小、快照号", parameters: { type: "object", properties: { project: { type: "string" }, dir: { type: "string", description: "相对项目根的子目录，不给就是项目根" } }, required: ["project"] } } },
      { type: "function", function: { name: "read_file", description: "读非设计稿的文件（.md / .json / .css / .svg…）。返回 content 与 sha256；改它之前先读，把 sha256 带回 write_file。二进制只给元数据", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "write_file", description: "写非设计稿的文件。写前用 expectSha256 校验（盘上被别人改过就拒绝），自动存快照可回退。不归一化、不动 frontmatter。.dc.html 会被拒，那个要用 write_draft", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, content: { type: "string", description: "整份新内容" }, expectSha256: { type: "string", description: "read_file 给的那个值；新建文件给 \"0\"" }, note: { type: "string", description: "这一版为什么改" } }, required: ["project", "path", "content"] } } },
      { type: "function", function: { name: "move_file", description: "改名 / 移动非设计稿的文件，并把稿里指向它的 href/src/url() 一起改掉", parameters: { type: "object", properties: { project: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["project", "from", "to"] } } },
      { type: "function", function: { name: "list_icons", description: "检索图标", parameters: { type: "object", properties: { project: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_icon", description: "取图标 SVG", parameters: { type: "object", properties: { project: { type: "string" }, name: { type: "string" } }, required: ["project", "name"] } } },
      { type: "function", function: { name: "get_syntax_guide", description: "取模板语义与写稿规则", parameters: { type: "object", properties: { topic: { type: "string", enum: ["template", "logic", "interaction", "checklist", "tokens"] } }, required: ["topic"] } } },
      { type: "function", function: { name: "validate_draft", description: "静态校验一份稿，errors 非空=不该落盘", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "write_draft", description: "整份写一份稿（唯一写入口），自动归一化/@ds展开/__resources注入/校验/快照", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, content: { type: "string" }, kind: { type: "string", enum: ["page", "component"] } }, required: ["project", "path", "content"] } } },
      { type: "function", function: { name: "patch_draft", description: "按 {old,new} 增量替换稿中的文本", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, edits: { type: "array" } }, required: ["project", "path", "edits"] } } },
      { type: "function", function: { name: "render_check", description: "真实渲染体检——唯一验收证据", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "list_versions", description: "列出一份稿的版本序列", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "diff_drafts", description: "两版之间的语义 diff（L1-L4 四级分类）", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["project", "path", "from"] } } },
      { type: "function", function: { name: "snapshot_draft", description: "取一份稿的语义快照", parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" }, version: { type: "string" } }, required: ["project", "path"] } } },
      { type: "function", function: { name: "locate_node", description: "把预览里点中的节点对回源码", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, node: { type: "string" } }, required: ["project", "file", "node"] } } },
      { type: "function", function: { name: "set_prop", description: "改一个节点上的一处属性/样式/文本", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, node: { type: "string" }, kind: { type: "string", enum: ["style", "attr", "text"] }, name: { type: "string" }, value: { type: "string" } }, required: ["project", "file", "node", "kind", "name", "value"] } } },
      { type: "function", function: { name: "revert_to", description: "把稿退回某一版（历史只增不改）", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" }, version: { type: "string" } }, required: ["project", "file", "version"] } } },
      { type: "function", function: { name: "list_references", description: "查询稿件的引用关系（谁引用了我/我引用了谁）", parameters: { type: "object", properties: { project: { type: "string" }, file: { type: "string" } }, required: ["project"] } } },
      { type: "function", function: { name: "get_changes_since", description: "跨版本净变更，回答「我实现的是 vX，现在最新 vY，我要改什么」", parameters: { type: "object", properties: { project: { type: "string" }, since: { type: "string" }, path: { type: "string" } }, required: ["project", "since"] } } },
    ];

    // 系统提示：设计助手角色 + 选中节点上下文
    const systemParts: string[] = [
      "你是 Umbra Studio 助手，在一个本地目录工作台里干活。**全程用简体中文回答**，包括思考过程里给用户看的那些话。",
      "这个目录里有两类文件，各走各的路，别串：",
      "  · **设计稿 `.dc.html`**：read_draft 读（每个元素带 data-ud-node 地址）→ set_prop 改一处 / patch_draft 增量改 / write_draft 整份写；改前后各 validate_draft 一次。",
      "  · **别的文件**（`.md`、`.json`、`.css`、图片…）：list_files 列 → read_file 读（拿 content 与 sha256）→ write_file 写（把那个 sha256 原样带回去，盘上被别人改过会被拒）。write_file 不归一化、不动 frontmatter。",
      "落盘要靠工具，不要口头说改了什么。",
      "⚠️ set_prop 只能改一处（一条样式/一个属性），用户说改多处时先改当前选中的。",
    ];
    if (nodeContext) {
      systemParts.push("", "### 当前选中节点（用户正在编辑的元素）", nodeContext, "", "用户说「这个」「这里」「字号大一点」等指向性描述时，就是指这个节点。用 set_prop 修改它的可编辑项，或调用 write_draft/patch_draft 做更大改动。");
    } else if (contextFile) {
      systemParts.push("", `### 用户当前正在看的稿：${contextFile}`, "用户说「这份稿」「这个按钮」时，默认指这份稿里的内容；先读它再改。");
    }
    if (filesContext) {
      systemParts.push("", "### 用户选中的文件", filesContext, "",
        "用户说「这几个」「它们」时就是指这些文件。要看内容用 read_file；改非设计稿用 write_file（带上 read_file 给的 sha256），改设计稿用 write_draft。");
    }
    if (rangeContext) {
      systemParts.push("", "### 用户选中的一段文字", rangeContext, "",
        "用户说「这段」时就是指它，**不要再问是哪一段**。改法：先 read_file 拿到全文与 sha256，把这一段替换掉、其余一个字都不动，再 write_file 带上那个 sha256。不要重写整份文档。");
    }
    if (regionContext) {
      systemParts.push("", "### 用户在图上圈的区域", regionContext, "", IMAGE_NOTE_SLOT);
    }

    /* 语言约束放最后一条：模型对系统提示末尾的指令更听话。
       放开头时 DeepSeek 仍会用英文写「I'll start by reading the file.」这类过渡句【实测 2026-09-24】。 */
    systemParts.push("", "### 语言", "所有回复一律用简体中文，包括「我先读一下文件」这类过渡句和工具调用前后的说明。不要用英文写给用户看的句子。");

    /* 图片只在通道支持时才随消息发。history 的最后一条是用户那句话，把图挂在它上面。 */
    if (canSeeImage && selectedRegion?.image) {
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]!;
        if (m.role !== "user" || typeof m.content !== "string") continue;
        m.content = [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: selectedRegion.image } },
        ];
        break;
      }
    }

    /** 系统提示随通道能力变（看不看得了图那句话不一样），所以降级时要重算 */
    const buildSystem = (seeImage: boolean) =>
      systemParts.map((x) => x === IMAGE_NOTE_SLOT ? imageNote(seeImage) : x).join("\n");

    const chatOpts = {
      messages: history,
      tools,
      maxSteps: 10,
      abortSignal,
      /* 逐步落盘（doc/00 §四十）：模型每回一条、每个工具一出结果就写进会话文件 ——
         界面轮询 chat_get 才能边跑边看到工具行长出来；中断时已跑的步骤也都留在会话里。 */
      onReply: async (reply: ChatMessage) => {
        await addMessage(p.dir, session!.id, {
          role: "assistant", content: typeof reply.content === "string" ? reply.content : (reply.content ?? []).map((x: { type: string; text?: string }) => x.type === "text" ? x.text ?? "" : "[图片]").join(""),
          ...(reply.tool_calls ? { toolCalls: reply.tool_calls } : {}),
        });
      },
      onToolCall: async (tc: ToolCall) => {
        const out = await executeToolCall(p, tc);
        // 工具结果要带 tool_call_id 落盘，否则续接会话时 provider 直接 422「missing field tool_call_id」【实测 DeepSeek 2026-09-23】
        await addMessage(p.dir, session!.id, { role: "tool", content: out, toolCallId: tc.id, toolName: tc.function.name });
        return out;
      },
    };

    let result = await chat(providerCfg, { ...chatOpts, systemPrompt: buildSystem(canSeeImage) });

    /* 订阅额度用完就退回按量那条（`11` Q33）。**只在这一轮什么都没干成时才退** ——
       已经调过工具（可能落过盘）的话重跑会重复改稿，那比报一次错糟得多。 */
    let fellBack: string | null = null;
    if (result.error && ch === "c" && looksLikeQuotaProblem(result.error) && !result.messages.some((m) => m.role === "assistant" && m.tool_calls?.length)) {
      const before = result.error;
      try {
        providerCfg = await getChannelA();
        canSeeImage = channelSupportsImage(providerCfg);
        if (!canSeeImage) stripImages(history);   // A 看不了图就别把图带过去
        result = await chat(providerCfg, { ...chatOpts, systemPrompt: buildSystem(canSeeImage) });
        fellBack = `通道 C 这一轮没跑成（${before.slice(0, 120)}），已自动换成通道 A（${providerCfg.model}）`;
        await addMessage(p.dir, session.id, { role: "system", content: fellBack });
      } catch (e) {
        // A 也没配就照原样报 C 的错
        void e;
      }
    }

    const diags = result.error ? [err(X.IO, p.rel, { kind: "key", name: "ai" }, result.error)] : [];
    session = (await loadChat(p.dir, session.id)) ?? session;   // 回包里的消息要含模型回复与工具调用，重新读盘

    // ── 审计本次 AI 会话对稿件的变更（M2-9） ──
    const changes: Array<{ path: string; from: string; to: string; counts: Record<string, number>; summary: string }> = [];
    try {
      const allDrafts = await listDrafts(p);
      for (const abs of allDrafts) {
        const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
        const vs = await listVersions(p, rel);
        if (!vs.length) continue;
        const before = draftVersionsBefore.get(rel);
        if (!before) continue;
        const after = vs[vs.length - 1];
        if (after === before) continue;  // 这个稿没变

        // 有变更，计算 diff
        const d = await diffDrafts(p, rel, { from: before, to: after });
        if (d.changes.length > 0) {
          changes.push({
            path: rel,
            from: before, to: after as string,   // 面板上「回退到 <from>」要知道退到哪一版
            counts: d.counts,
            summary: `${d.counts.L1 ?? 0} 处契约变更(需改代码) · ${d.counts.L2 ?? 0} 处取值变更 · ${d.counts.L3 ?? 0} 处文案变更 · ${d.counts.L4 ?? 0} 处等价变更`,
          });
        }
      }
    } catch { /* 忽略，不影响主流程 */ }

    const chVal: "a" | "b" | "c" = ch;
    return envelope<{ sessionId: string; channel: "a" | "b" | "c"; messages: ChatEntry[]; usage: typeof result.usage; interrupted: boolean; changes: typeof changes; fellBack?: string | null }>({
      sessionId: session.id,
      channel: chVal,
      messages: session.messages.slice(-10),
      usage: result.usage,
      interrupted: result.interrupted,
      changes,
    }, diags, {});
  }

  // 通道 B：Claude Code 子进程（M2-3）

  // 记录循环前各稿的版本（用于审计变更）
  const draftVersionsBeforeB: Map<string, string> = new Map();
  try {
    const allDrafts = await listDrafts(p);
    for (const abs of allDrafts) {
      const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
      const vs = await listVersions(p, rel);
      if (vs.length > 0) draftVersionsBeforeB.set(rel, vs[vs.length - 1] as string);
    }
  } catch { /* 忽略 */ }

  const bCfg = await getChannelB();  // 通道 B 自己的配置，不和 A 共用（doc/11 Q11）
  const bCli = bCfg.cli ?? "claude";
  const bSpec = specOf(bCli);

  /* 通道 B 的系统提示。
     **第一句必须是当前项目的绝对路径** —— 通道 B 的工具跑在独立的 MCP server 进程里，
     它不像通道 A/C 那样天生知道「用户正在看哪个项目」，只能靠 `project` 参数。
     不给路径它就得 `list_projects` 猜，而用户打开的目录多半不在 projectsRoot 下（这正是
     Umbra Studio 的核心场景），于是它反复试到超时 —— 2026-09-24 实测 120 秒耗尽、零工具调用。 */
  const bSystemParts: string[] = [
    "你是 Umbra Studio 设计助手。你可以通过 MCP 工具 umbrastudio 读取和修改这个项目里的文件。",
    "",
    "### 当前项目（所有工具的 project 参数一律传这个绝对路径，不要传项目名，也不要去 list_projects 找）",
    `project = ${p.dir}`,
    `项目名：${p.name}${p.title && p.title !== p.name ? `（${p.title}）` : ""}`,
    "",
    "两类文件分两条路走，不要混：",
    "- `.dc.html` 设计稿 → `write_draft` / `patch_draft`。改前先 `validate_draft`，改完再 `validate` 一次。",
    "- 其它文件（`.md`、代码、文本）→ `read_file` / `write_file`。`write_file` 要先读到 sha256 再带上，它靠这个防覆盖。",
    "",
    "全程用简体中文回答。",
  ];
  if (nodeContext) {
    bSystemParts.push("", "### 当前选中节点", nodeContext, "", "用户说「这个」「这里」时，就是指这个节点。");
  } else if (contextFile) {
    bSystemParts.push("", `### 用户当前正在看的稿：${contextFile}`);
  }
  if (filesContext) bSystemParts.push("", "### 用户选中的文件", filesContext);
  if (rangeContext) bSystemParts.push("", "### 用户选中的一段文字", rangeContext, "", "只改这一段，其余不动。");

  const ccResult = await runLocalCli({
    cli: bCli,
    model: bCfg.model,
    mcpServerPath: join(TOOL_ROOT, "server", "dist", "index.js"),
    cwd: p.dir,
    prompt: message,
    systemPrompt: bSystemParts.join("\n"),
    timeoutMs: 240000,
    maxBudgetUsd: bCfg.maxBudgetUsd,
    baseUrl: bCfg.baseUrl,
    apiKey: bCfg.apiKey,
    logFile: process.env.UMBRASTUDIO_CHANNEL_B_LOG,
  });

  /* 把结果存入会话。**要拿 addMessage 的返回值覆盖 session** ——
     它写的是盘上的文件，内存里这个 `session` 是请求开始时读的旧对象，
     而下面 `messages: session.messages.slice(-10)` 就是从它取的。不覆盖的话
     前端发一次消息只看得到自己那句，AI 的回答要等下次刷新才出现（2026-09-24 实测）。 */
  if (ccResult.result) {
    session = await addMessage(p.dir, session.id, { role: "assistant", content: ccResult.result });
  }

  const usageInfo = ccResult.usage
    ? { promptTokens: ccResult.usage.inputTokens, completionTokens: ccResult.usage.outputTokens, totalTokens: ccResult.usage.inputTokens + ccResult.usage.outputTokens }
    : null;

  const diagsB = ccResult.error
    ? [err(X.IO, p.rel, { kind: "key", name: "channel-b" }, `${bSpec.label}：${ccResult.error}`,
        bSpec.verified ? undefined : { fix: `这个 CLI 的适配器还没在真机上验过（${bSpec.note}）。要看它到底吐了什么：UMBRASTUDIO_CHANNEL_B_LOG=<文件> 再跑一次` })]
    : [];
  /* 为了让 CLI 认得我们的 MCP server，有些 CLI 要在项目里落一个配置文件（cursor 的 .cursor/mcp.json）。
     **动了用户的项目就要说一声** —— 悄悄写文件是最招人烦的那种「贴心」。 */
  if (ccResult.wroteFiles.length) {
    await addMessage(p.dir, session.id, { role: "system",
      content: `为了让 ${bSpec.label} 认得 Umbra 的工具，在这个项目里写了 ${ccResult.wroteFiles.join("、")}（只加了 umbrastudio 这一项，你原有的其它 MCP server 没动）。` });
  }

  // ── 审计本次 AI 会话对稿件的变更（M2-9，通道 B） ──
  const changesB: Array<{ path: string; from: string; to: string; counts: Record<string, number>; summary: string }> = [];
  try {
    const allDrafts = await listDrafts(p);
    for (const abs of allDrafts) {
      const rel = abs.slice(p.dir.length + 1).split("\\").join("/");
      const vs = await listVersions(p, rel);
      if (!vs.length) continue;
      const before = draftVersionsBeforeB.get(rel);
      if (!before) continue;
      const after = vs[vs.length - 1];
      if (after === before) continue;

      const d = await diffDrafts(p, rel, { from: before, to: after });
      if (d.changes.length > 0) {
        changesB.push({
          path: rel,
          from: before, to: after as string,
          counts: d.counts,
          summary: `${d.counts.L1 ?? 0} 处契约变更(需改代码) · ${d.counts.L2 ?? 0} 处取值变更 · ${d.counts.L3 ?? 0} 处文案变更 · ${d.counts.L4 ?? 0} 处等价变更`,
        });
      }
    }
  } catch { /* 忽略 */ }

  const chValB: "a" | "b" | "c" = ch;
  return envelope<{ sessionId: string; channel: "a" | "b" | "c"; messages: ChatEntry[]; usage: typeof usageInfo; interrupted: boolean; toolCalls: typeof ccResult.toolCalls; numTurns: number; changes: typeof changesB }>({
    sessionId: session.id,
    channel: chValB,
    messages: session.messages.slice(-10),
    usage: usageInfo,
    interrupted: false,
    toolCalls: ccResult.toolCalls,
    numTurns: ccResult.numTurns,
    changes: changesB,
  }, diagsB, {});
}
