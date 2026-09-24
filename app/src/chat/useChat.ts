import { useCallback, useEffect, useRef, useState } from "react";
import type { Core } from "../api/client";
import type { ChatMessage, ChatNote, ChatSessionRow, ChatUsage, Selection } from "../api/types";

interface Cap {
  model: string; supportsImage: boolean; via?: "local" | "endpoint"; cli?: string; cliLabel?: string;
  /** 界面上叫什么（服务端给，前端不另抄一份映射）：DeepSeek / Claude Code / 火山方舟 */
  engine?: string;
  /** 谁在付钱 */
  billing?: "本机订阅" | "按量" | "订阅端点";
  group?: string;
}
import { mem } from "../layout/layout";
import { pickChannel as pickChannelShared } from "./channel";
import { toast } from "../ui/Toast";

/** AI 会话（M2-12 / §四十）：作业化 —— chat_send async 拿 jobId，每 1.2 s 拉一次会话正文与作业状态；WS 的 chat 事件到了也拉一次 */
export function useChat(core: Core, dir: string, ctx: { selectedDraft: string | null; selections: Selection[]; afterChanges: () => void }) {
  const [channel, setChannel] = useState<"a" | "b" | "c">(() => mem.get("us.chatChannel", "a"));
  /** 当前通道的模型名与它吃不吃图（M8-10：不支持时圈选入口禁用并说明原因） */
  const [caps, setCaps] = useState<{ a?: Cap; b?: Cap; c?: Cap }>({});
  /** 后端配的默认通道（`defaultChannel`）只在用户没切过时生效；切过一次就一直用用户的 */
  const followedDefault = useRef(false);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<ChatNote[]>([]);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const job = useRef<string | null>(null);
  const ctxRef = useRef(ctx); ctxRef.current = ctx;

  /** 拉会话列表（历史面板与顶栏都用它） */
  const reloadSessions = useCallback(async () => {
    const r = await core.get<{ sessions: ChatSessionRow[] }>("chat_list").catch(() => null);
    const list = r?.data?.sessions ?? [];
    setSessions(list);
    return list;
  }, [core]);

  /** 切到某一条历史会话 */
  const openSession = useCallback(async (id: string) => {
    const g = await core.get<{ id: string; messages: ChatMessage[]; channel?: "a" | "b" | "c" }>("chat_get?session=" + encodeURIComponent(id)).catch(() => null);
    if (!g?.data) { toast("这条会话打不开", undefined, "error"); return; }
    setSessionId(g.data.id); setMessages(g.data.messages ?? []); setNotes([]); setUsage(null);
    if (g.data.channel) setChannel(g.data.channel);
  }, [core]);

  const load = useCallback(async () => {
    setSessionId(null); setMessages([]); setNotes([]); setUsage(null);
    const list = await reloadSessions();
    /* 进项目自动接上**最近说过话的那条**。列表里已经滤掉了空会话（后端做的），
       所以这里接到的一定是有内容的。 */
    if (list.length) {
      const latest = list.slice().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0]!;
      await openSession(latest.id);
    }
  }, [reloadSessions, openSession]);
  useEffect(() => { void load(); }, [load, dir]);
  const reloadCaps = useCallback(async () => {
    const r = await core.get<{ channelA?: Cap | null; channelB?: Cap | null; channelC?: Cap | null; defaultChannel?: "a" | "b" | "c" }>("ai_config").catch(() => null);
    if (!r?.data) return;
    setCaps({ a: r.data.channelA ?? undefined, b: r.data.channelB ?? undefined, c: r.data.channelC ?? undefined });
    // 没切过就跟后端的默认通道（用户把订阅那条配成默认时，进来就该是它）
    if (!followedDefault.current && mem.get<string | null>("us.chatChannel", null) === null) {
      followedDefault.current = true;
      const d = r.data.defaultChannel;
      if (d === "a" || d === "b" || d === "c") setChannel(d);
    }
  }, [core]);
  useEffect(() => { void reloadCaps(); }, [reloadCaps]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const r = await core.post<{ title: string; titled: boolean }>("chat_rename", { session: id, title });
    if (!r.ok) { toast("改名没成", r.errors?.[0]?.message, "error"); return; }
    await reloadSessions();
  }, [core, reloadSessions]);

  /** 删一条会话。**真删** —— 界面上的「已删除 · 撤销」由调用方自己维持一小段时间，
   *  离开列表时才调到这里（设计侧第六轮：删除不弹确认框，行塌成一行可撤销）。 */
  const deleteSession = useCallback(async (id: string) => {
    const r = await core.post("chat_delete", { session: id });
    if (!r.ok) { toast("删不掉", r.errors?.[0]?.message, "error"); return; }
    const list = await reloadSessions();
    if (id === sessionId) {
      // 删掉的正是当前这条：接上剩下里最近的，没有就变成新会话
      const next = list.slice().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      if (next) await openSession(next.id);
      else { setSessionId(null); setMessages([]); setNotes([]); setUsage(null); }
    }
  }, [core, reloadSessions, openSession, sessionId]);

  const newSession = useCallback(() => { setSessionId(null); setMessages([]); setNotes([]); setUsage(null); }, []);
  const pickChannel = useCallback((c: "a" | "b" | "c") => { setChannel(c); pickChannelShared(c); }, []);
  /* 设置面板里也能切通道（在那儿选 CLI 的人多半就是想用它）。
     它发这个事件，这里跟上 —— 不然会出现「设置里选了 Codex，会话栏还停在通道 C」。 */
  useEffect(() => {
    const on = (e: Event) => { const c = (e as CustomEvent<"a" | "b" | "c">).detail; if (c === "a" || c === "b" || c === "c") setChannel(c); };
    window.addEventListener("ud-pick-channel", on);
    return () => window.removeEventListener("ud-pick-channel", on);
  }, []);

  const send = useCallback(async (textIn?: string, selIn?: Selection[]) => {
    const text = (textIn ?? input).trim();
    if (!text || running) return;
    const sels = selIn ?? ctxRef.current.selections;
    const node = sels.find((s) => s.kind === "node")?.ref;
    setInput(""); setRunning(true);
    setMessages((m) => m.concat([{ role: "user", content: text, timestamp: new Date().toISOString() }]));
    try {
      const body: Record<string, unknown> = { message: text, channel, async: true };
      if (sessionId) body.sessionId = sessionId;
      if (ctxRef.current.selectedDraft) body.contextFile = ctxRef.current.selectedDraft;
      if (node?.node) { body.selectedNodeFile = node.file; body.selectedNodeAddress = node.node; }
      // files 药丸：把路径带过去（M8-4）。range / region 随 M8-6 / M8-10 接
      const files = sels.filter((s) => s.kind === "files").flatMap((s) => s.detail.split("\n")).filter(Boolean);
      if (files.length) body.selectedFiles = files;
      // range 药丸（.md 选中一段，M8-8）：把路径、行范围、原文一起带过去
      const range = sels.find((s) => s.kind === "range");
      if (range) { const [head, ...rest] = range.detail.split("\n"); body.selectedRange = { label: head, text: rest.join("\n") }; }
      // region 药丸（图片圈选，M8-10）：坐标 + 备注 + 裁出来的那一块
      const region = sels.find((s) => s.kind === "region");
      if (region) { const [head, ...rest] = region.detail.split("\n"); body.selectedRegion = { label: head, note: rest.join("\n"), image: region.image ?? null }; }
      const started = await core.post<{ jobId: string; sessionId?: string }>("chat_send", body);
      if (!started.ok || !started.data) throw new Error(started.errors?.[0]?.message ?? "起作业失败");
      job.current = started.data.jobId; const sid = started.data.sessionId ?? sessionId!; setSessionId(sid);
      type Done = { running?: boolean; error?: { message?: string; code?: string }; result?: { data?: { usage?: ChatUsage; interrupted?: boolean; changes?: Array<{ path: string; from: string; to: string; summary: string }> }; errors?: Array<{ message?: string; code?: string }> } };
      let done: Done | null = null;
      for (let i = 0; i < 600 && !done; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const g = await core.get<{ messages: ChatMessage[] }>("chat_get?session=" + encodeURIComponent(sid));
          if (g.data?.messages) setMessages(g.data.messages);
          const st = await core.get<Done>("chat_status?job=" + encodeURIComponent(job.current!));
          if (st.data && st.data.running === false) done = st.data;
        } catch { /* 网络抖一下不算失败 */ }
      }
      if (!done) throw new Error("等了 12 分钟还没结束");
      const d = done.result?.data ?? {};
      const add: ChatNote[] = [];
      if (done.error) add.push({ kind: "err", idx: 0, text: "出错：" + (done.error.message ?? done.error.code) });
      if (done.result?.errors?.length) add.push({ kind: "err", idx: 0, text: "出错：" + (done.result.errors[0]!.message ?? done.result.errors[0]!.code) });
      if (d.usage) setUsage(d.usage);
      if (d.interrupted) add.push({ kind: "err", idx: 0, text: "已中断（这一步之前落盘的改动照常可审可回退）" });
      for (const ch of d.changes ?? []) add.push({ kind: "change", idx: 0, path: ch.path, from: ch.from, to: ch.to, summary: ch.summary, reverted: false });
      setNotes((n) => n.concat(add.map((x, i) => ({ ...x, idx: n.length + i }))));
      const g2 = await core.get<{ messages: ChatMessage[] }>("chat_get?session=" + encodeURIComponent(sid)).catch(() => null);
      if (g2?.data?.messages) setMessages(g2.data.messages);
      if ((d.changes ?? []).length) ctxRef.current.afterChanges();
    } catch (e) { setNotes((n) => n.concat([{ kind: "err", idx: n.length, text: "发送失败：" + String((e as Error).message ?? e) }])); }
    finally { setRunning(false); job.current = null; }
  }, [core, input, running, channel, sessionId]);

  const interrupt = useCallback(async () => {
    if (!job.current) return;
    const r = await core.post("chat_interrupt", { job: job.current }).catch((e: Error) => ({ ok: false, errors: [{ message: e.message }] }));
    if (r.ok) toast("已发中断，等这一步结束", undefined, "ok"); else toast("中断失败", r.errors?.[0]?.message, "error");
  }, [core]);

  const revert = useCallback(async (idx: number) => {
    const n = notes[idx]; if (!n || n.reverted || !n.path) return;
    const r = await core.post<{ write?: { version?: string } }>("revert", { file: n.path, version: n.from });
    if (r.ok) { setNotes((ns) => ns.map((x, i) => i === idx ? { ...x, reverted: true } : x)); toast(`已退回 ${n.from}`, `历史不删，${r.data?.write?.version ?? "新一版"} 是回退版`, "ok"); ctxRef.current.afterChanges(); }
    else toast("回退失败", r.errors?.[0]?.message, "error");
  }, [core, notes]);

  return { channel, pickChannel, sessions, sessionId, messages, notes, usage, running, input, setInput, send, interrupt, revert, newSession, reload: load,
    openSession, renameSession, deleteSession, reloadSessions,
    model: caps[channel]?.model ?? "", supportsImage: caps[channel]?.supportsImage ?? false, caps, reloadCaps };
}
export type ChatStore = ReturnType<typeof useChat>;
