import { useCallback, useEffect, useRef, useState } from "react";
import type { Core, UdEvent } from "../api/client";
import { baseName, type ChangesData, type Comment, type Diag, type Draft, type Health, type SourceData } from "../api/types";
import { toast } from "../ui/Toast";

/** 一个项目在前端的状态：稿件列表 / 当前稿 / 诊断 / 评论 / 变更 / 源码，以及拉取它们的函数。
 *  和旧前端 fetchDrafts / fetchDiagnostics / fetchComments / fetchChanges 同一份 API 用法。 */
export function useProject(core: Core, dir: string) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [indexed, setIndexed] = useState(true);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  const [diags, setDiags] = useState<Diag[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [changes, setChanges] = useState<ChangesData | null>(null);
  const [source, setSource] = useState<SourceData | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<UdEvent | null>(null);
  const [wsState, setWsState] = useState<"open" | "closed">("closed");
  const autoIndexed = useRef(false);
  const sel = useRef<string | null>(null); sel.current = selected;

  const fetchDrafts = useCallback(async () => {
    const r = await core.get<{ drafts?: Array<Partial<Draft> & { file: string }>; files?: string[]; indexed: boolean }>("drafts");
    if (!r.ok || !r.data) { toast("获取稿件列表失败", r.errors?.[0]?.message, "error"); return; }
    if (r.data.indexed === false && !autoIndexed.current) {   // 从没建过索引：壳、桥、健康读数都靠它，先建一次（只试一次）
      autoIndexed.current = true;
      try { await core.post("rebuild_index", {}); return fetchDrafts(); } catch { /* 建不了就用文件名 */ }
    }
    setIndexed(r.data.indexed !== false);
    setDrafts((prev) => {
      const old = new Map(prev.map((d) => [d.file, d]));
      const rows: Array<Partial<Draft> & { file: string }> = r.data!.drafts ?? (r.data!.files ?? []).map((f) => ({ file: f }));
      return rows.map((d) => ({
        file: d.file, title: d.title || baseName(d.file).replace(/\.dc\.html$/, ""), kind: (d.kind as Draft["kind"]) || "page",
        health: (d.health as Health) || "unchecked", healthWhy: d.healthWhy || (r.data!.indexed ? "" : "还没建过索引"),
        diagnostics: d.diagnostics || { errors: 0, warnings: 0 }, elements: d.elements ?? old.get(d.file)?.elements ?? null,
        version: d.version ?? old.get(d.file)?.version ?? null, updatedAt: d.updatedAt ?? null, states: d.states ?? [], imports: d.imports ?? [], importedBy: d.importedBy ?? [],
      }));
    });
  }, [core]);

  const fetchDiagnostics = useCallback(async (file: string) => {
    const r = await core.get<{ diags: Diag[]; stats?: { elements?: number; kind?: string }; workspace?: { version?: string }; check?: { alive: boolean; nodeCount: number; renderMs: number; counts?: Record<string, number> } | null; checkStale?: boolean }>("validate?file=" + encodeURIComponent(file));
    if (!r.data) return;
    const ds = r.data.diags ?? [];
    if (sel.current === file) setDiags(ds);
    const errors = ds.filter((d) => d.level === "error").length, warnings = ds.filter((d) => d.level === "warning").length;
    const chk = r.data.checkStale ? null : r.data.check;
    // 健康四色按 indexpage.judgeHealth 的口径就地重算：宁可说不知道，不可以说通过
    let health: Health, why: string;
    if (errors) { health = "error"; why = `${errors} 条 error 级诊断，落盘会被拒`; }
    else if (chk && !chk.alive) { health = "error"; why = "体检时页面没画出来"; }
    else if (!chk) { health = "unchecked"; why = r.data.check ? "稿改过之后没再体检，旧读数不算数" : "还没跑过 render_check"; }
    else if (warnings || (chk.counts && (chk.counts.unresolvedHoles || chk.counts.externalRequests || chk.counts.missingResources))) { health = "warn"; why = warnings ? `${warnings} 条 warning` : "体检有提醒（洞 / 外部请求 / 404）"; }
    else { health = "ok"; why = `静态校验干净，体检 ${chk.nodeCount} 节点 · ${chk.renderMs} ms`; }
    setDrafts((prev) => prev.map((d) => d.file === file ? { ...d, health, healthWhy: why, diagnostics: { errors, warnings }, elements: r.data!.stats?.elements ?? d.elements, kind: (r.data!.stats?.kind as Draft["kind"]) ?? d.kind, version: r.data!.workspace?.version ?? d.version } : d));
  }, [core]);

  const fetchComments = useCallback(async (file: string) => {
    const r = await core.get<{ comments: Comment[] }>("comments?file=" + encodeURIComponent(file));
    if (sel.current === file) setComments(r.data?.comments ?? []);
  }, [core]);
  const fetchChanges = useCallback(async (file: string) => {
    const r = await core.get<ChangesData>("changes?file=" + encodeURIComponent(file));
    if (sel.current === file) setChanges(r.ok && r.data ? r.data : null);
  }, [core]);
  const fetchSource = useCallback(async (file: string) => {
    const r = await core.get<SourceData>("source?file=" + encodeURIComponent(file));
    if (sel.current === file && r.ok && r.data) setSource(r.data);
  }, [core]);

  const select = useCallback((file: string | null) => {
    setSelectedRaw(file); sel.current = file;
    setDiags([]); setComments([]); setChanges(null); setSource(null);
    if (file && /\.dc\.html$/.test(file)) { void fetchDiagnostics(file); void fetchComments(file); void fetchChanges(file); }
  }, [fetchDiagnostics, fetchComments, fetchChanges]);

  /** 体检：POST check → 轮询 check_status；完了重建索引再拉列表（健康读数是索引算的） */
  const runCheck = useCallback(async (file: string) => {
    setChecking(file);
    try {
      const r = await core.post<{ jobId: string }>("check", { file });
      if (!r.ok || !r.data) throw new Error(r.errors?.[0]?.message ?? "起作业失败");
      for (let i = 0; i < 120; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await core.get<{ running: boolean; ok: boolean | null; error?: { message?: string }; result?: { result?: { alive: boolean; nodeCount: number; renderMs: number } } }>("check_status?job=" + encodeURIComponent(r.data.jobId));
        if (s.data && s.data.running === false) {
          if (s.data.error) toast("体检出错", s.data.error.message, "error");
          else { const rr = s.data.result?.result; toast(rr?.alive === false ? "体检完成：页面没画出来（1+1 都算不出）" : `体检完成：${rr?.nodeCount ?? "?"} 节点 · ${rr?.renderMs ?? "?"} ms`, undefined, rr?.alive === false ? "error" : "ok"); }
          break;
        }
      }
    } catch (e) { toast("体检失败", String((e as Error).message ?? e), "error"); }
    finally {
      setChecking(null);
      try { await core.post("rebuild_index", {}); } catch { /* 旧读数 */ }
      await fetchDrafts(); if (sel.current) void fetchDiagnostics(sel.current);
    }
  }, [core, fetchDrafts, fetchDiagnostics]);

  const rebuildIndex = useCallback(async () => {
    toast("正在重建索引…"); const r = await core.post("rebuild_index", {});
    if (r.ok) { toast("索引重建完成", undefined, "ok"); await fetchDrafts(); } else toast("索引重建失败", r.errors?.[0]?.message, "error");
  }, [core, fetchDrafts]);

  // 首次进项目拉列表；WS 事件到了按需刷新
  useEffect(() => { void fetchDrafts(); }, [fetchDrafts, dir]);
  useEffect(() => core.events((e) => {
    setLastEvent(e);
    if (e.type === "write" || e.type === "fs") { void fetchDrafts(); const f = sel.current; const p = e.payload as { file?: string; changes?: string[] }; if (f && (p.file === f || p.changes?.includes(f))) { void fetchDiagnostics(f); void fetchChanges(f); } }
  }, setWsState), [core, fetchDrafts, fetchDiagnostics, fetchChanges]);

  return { drafts, indexed, selected, select, diags, comments, changes, source, checking, lastEvent, wsState, fetchDrafts, fetchDiagnostics, fetchComments, fetchChanges, fetchSource, runCheck, rebuildIndex };
}
export type ProjectStore = ReturnType<typeof useProject>;
