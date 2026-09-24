/** 会话模型（M2-5）
 *
 * 会话与项目绑定，存 `.umbrastudio/chats/`。关掉应用重开会话还在。
 * 每条消息记录角色、内容、工具调用、时间戳。
 */

import { emit } from "./events.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./normalize.js";
import type { ToolCall } from "./provider.js";

export interface ChatEntry {
  id: string;            // uuid
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: string;     // ISO
}

export interface ChatSession {
  id: string;            // uuid
  projectId: string;
  channel: "a" | "b" | "c";   // A / C 直连 OpenAI 兼容端点（C 是订阅额度那条），B 是本地 CLI
  model: string;         // 用的模型名
  /** 会话标题（M8-12）。缺省时由首条用户消息生成；用户可以改，改完写回同一个键。
   *  设计侧第六轮点出来的：`chat-<时间戳>-<随机>` 这种 id **直接显示很丑**，列表里要有能看的名字。 */
  title?: string;
  /** channel b 下**具体是哪个本机 CLI**（claude / codex / cursor-agent）。
   *  只记 channel 的话，界面只能写「本机工具」，看不出是谁在干活。 */
  tool?: string;
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
  messages: ChatEntry[];
  status: "active" | "interrupted" | "done";
}

export interface ChatListResult {
  sessions: {
    id: string; model: string; channel: string; updatedAt: string; msgCount: number;
    /** 具体哪个本机 CLI（只有 channel b 有） */
    tool?: string;
    /** 能看的名字：用户起的，或首条用户消息截出来的 */
    title: string;
    /** true = 用户起的名字；false = 我们从首条消息猜的 */
    titled: boolean;
  }[];
}

/** 从首条用户消息截一个标题。
 *  取 40 字是设计侧定的；换行和多余空白压成单空格，否则列表里会撑出奇怪的高度。
 *  一条用户消息都没有（空会话）时给空串 —— 空会话本来就不该进历史（设计侧第六轮的规矩）。 */
function autoTitle(s: ChatSession): string {
  const first = s.messages.find((m) => m.role === "user");
  if (!first) return "";
  const t = first.content.replace(/\s+/g, " ").trim();
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

export interface CreateChatOpts {
  projectId: string;
  channel: "a" | "b" | "c";
  model: string;
  /** channel b 下具体哪个本机 CLI —— 记下来，否则历史列表只能写「本机工具」 */
  tool?: string;
}

// ── 路径 ──

const CHATS_DIR = ".umbrastudio" + "/chats";

function chatsDir(projectDir: string): string {
  return join(projectDir, CHATS_DIR);
}

function sessionFile(projectDir: string, id: string): string {
  return join(chatsDir(projectDir), id + ".json");
}

// ── CRUD ──

export async function createChat(projectDir: string, opts: CreateChatOpts): Promise<ChatSession> {
  const dir = chatsDir(projectDir);
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const session: ChatSession = {
    id: "chat-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    projectId: opts.projectId,
    channel: opts.channel,
    model: opts.model,
    ...(opts.tool ? { tool: opts.tool } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
    status: "active",
  };

  await writeAtomic(sessionFile(projectDir, session.id), JSON.stringify(session, null, 2) + "\n");
  return session;
}

export async function loadChat(projectDir: string, id: string): Promise<ChatSession | null> {
  const f = sessionFile(projectDir, id);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, "utf8")) as ChatSession;
}

export async function saveChat(projectDir: string, session: ChatSession): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await writeAtomic(sessionFile(projectDir, session.id), JSON.stringify(session, null, 2) + "\n");
}

export async function listChats(projectDir: string): Promise<ChatListResult> {
  const dir = chatsDir(projectDir);
  if (!existsSync(dir)) return { sessions: [] };

  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const sessions = await Promise.all(
    files.map(async (f) => {
      const s = JSON.parse(await readFile(join(dir, f), "utf8")) as ChatSession;
      return {
        id: s.id,
        model: s.model,
        channel: s.channel,
        tool: s.tool,
        /* 标题：用户改过就用他的；没改过就现算一个。
           **不把算出来的标题写回盘** —— 那会让「用户没改过」这件事无从分辨，
           以后想换生成规则也改不动老会话。显示层要的是一个能看的名字，不是一份存档。 */
        title: s.title ?? autoTitle(s),
        /** 这个标题是用户起的还是我们猜的 —— 界面要能分（猜的可以淡一点） */
        titled: !!s.title,
        updatedAt: s.updatedAt,
        msgCount: s.messages.length,
      };
    }),
  );
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions };
}

export async function deleteChat(projectDir: string, id: string): Promise<boolean> {
  const f = sessionFile(projectDir, id);
  if (!existsSync(f)) return false;
  const { unlink } = await import("node:fs/promises");
  await unlink(f);
  return true;
}

export async function addMessage(projectDir: string, sessionId: string, entry: Omit<ChatEntry, "id" | "timestamp">): Promise<ChatSession> {
  const session = await loadChat(projectDir, sessionId);
  if (!session) throw new Error(`Chat session ${sessionId} not found`);

  const msg: ChatEntry = {
    ...entry,
    id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
  };
  session.messages.push(msg);
  await saveChat(projectDir, session);
  emit("chat", projectDir, { sessionId, entry: { role: entry.role, toolName: (entry as { toolName?: string }).toolName ?? null } });
  return session;
}

/** 给会话起个名字（M8-12）。空串 = 清掉用户起的名字，回到自动标题。 */
export async function renameChat(projectDir: string, sessionId: string, title: string): Promise<ChatSession> {
  const s = await loadChat(projectDir, sessionId);
  if (!s) throw new Error(`没有这个会话：${sessionId}`);
  const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (t) s.title = t; else delete s.title;
  /* **不动 updatedAt** —— 那一栏是「最后说话的时间」，历史列表按它排序。
     改个名字就把会话顶到最前面，会打乱用户对列表顺序的预期。 */
  await saveChat(projectDir, s);
  return s;
}
