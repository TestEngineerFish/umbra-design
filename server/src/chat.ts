/** 会话模型（M2-5）
 *
 * 会话与项目绑定，存 `.umbradesign/chats/`。关掉应用重开会话还在。
 * 每条消息记录角色、内容、工具调用、时间戳。
 */

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
  channel: "a" | "b";    // 通道 A（直连）或 B（Claude Code）
  model: string;         // 用的模型名
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
  messages: ChatEntry[];
  status: "active" | "interrupted" | "done";
}

export interface ChatListResult {
  sessions: { id: string; model: string; channel: string; updatedAt: string; msgCount: number }[];
}

export interface CreateChatOpts {
  projectId: string;
  channel: "a" | "b";
  model: string;
}

// ── 路径 ──

const CHATS_DIR = ".umbradesign" + "/chats";

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
  return session;
}
