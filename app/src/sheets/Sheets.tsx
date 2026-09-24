import { useCallback, useEffect, useState } from "react";
import type { Core } from "../api/client";
import { baseName, type CliStatus, type DirInfo } from "../api/types";
import type { HostAdapter } from "../host";
import type { LayoutState } from "../layout/layout";
import { toast } from "../ui/Toast";

function Sheet({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on); }, [onClose]);
  return <div className="fixed inset-0 z-40 bg-black/25 flex items-start justify-center pt-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" className={`bg-panel border border-border rounded-lg shadow-2xl p-5 flex flex-col gap-4 text-xs ${wide ? "w-[880px] max-w-[95vw]" : "w-[520px] max-w-[95vw]"}`}>{children}</div></div>;
}
const Field = ({ label, children, note, err }: { label: string; children: React.ReactNode; note?: string; err?: boolean }) => <label className="flex flex-col gap-1"><span className="text-muted">{label}</span>{children}{note && <span className={err ? "text-err" : "text-muted"}>{note}</span>}</label>;
const inputCls = "h-8 px-3 rounded border border-border bg-bg outline-none focus:border-accent";

/** 新建稿件：走 create_draft（唯一写入口），建完自动选中 */
export function NewDraftSheet({ core, current, onClose, onCreated }: { core: Core; current: string | null; onClose: () => void; onCreated: (file: string) => void }) {
  const [name, setName] = useState(""); const [title, setTitle] = useState(""); const [source, setSource] = useState<"blank" | "copy">("blank"); const [busy, setBusy] = useState(false);
  const n = name.trim(); const fileName = n ? (n.endsWith(".dc.html") ? n : n + ".dc.html") : ""; const bad = !!n && /[\\/:*?"<>|]/.test(n);
  const submit = async () => {
    setBusy(true);
    const r = await core.post("create_draft", { path: fileName, source, title: source === "blank" ? (title.trim() || undefined) : undefined, sourceFile: source === "copy" ? current : undefined });
    if (r.ok) { toast(`已新建 ${fileName}`, undefined, "ok"); onCreated(fileName); onClose(); } else { toast("新建稿件失败", r.errors?.[0]?.message, "error"); setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <h2 className="text-base font-semibold">新建稿件</h2>
    <Field label="文件名" note={bad ? "文件名不能含 \\ / : * ? \" < > |" : fileName ? `将写入 ${fileName}` : "会自动补 .dc.html"} err={bad}><input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：设置 · 账号与凭据" /></Field>
    <Field label="标题"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="不填就用文件名" /></Field>
    <Field label="来源"><div className="seg self-start"><button className={source === "blank" ? "on" : ""} onClick={() => setSource("blank")}>空白骨架</button><button className={source === "copy" ? "on" : ""} disabled={!current} onClick={() => setSource("copy")} title={current ? `复制当前选中的 ${current}` : "先选中一份稿"}>复制当前稿</button></div></Field>
    <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!fileName || bad || busy} onClick={() => void submit()}>{busy ? "正在建…" : "新建"}</button></div>
  </Sheet>;
}

/** 新建 / 导入目录：目录本身成为项目根；已有稿被接管不改动 */
export function NewProjectSheet({ hub, host, initialDir, onClose, onOpen }: { hub: Core; host: HostAdapter; initialDir?: string; onClose: () => void; onOpen: (dir: string) => void }) {
  const [dir, setDir] = useState(initialDir ?? ""); const [name, setName] = useState(""); const [title, setTitle] = useState(""); const [info, setInfo] = useState<DirInfo | null>(null); const [busy, setBusy] = useState(false);
  const cap = host.capabilities().pickDirectory;
  const inspect = async (d: string) => { if (!d.trim()) return; const r = await hub.get<DirInfo>("inspect_dir?dir=" + encodeURIComponent(d.trim())); if (r.ok && r.data) { setInfo(r.data); if (!name && r.data.suggestedName) setName(r.data.suggestedName); } };
  useEffect(() => { if (initialDir) void inspect(initialDir); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async () => { const d = await host.pickDirectory({ title: "选择项目目录" }); if (!d) { if (!cap.ok) toast("选目录", cap.why); return; } setDir(d); if (!name) setName(baseName(d).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")); void inspect(d); };
  const nm = name.trim(); const nameBad = !!nm && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(nm);
  const submit = async () => {
    setBusy(true);
    const r = await hub.post<{ dir?: string; name?: string }>("create_project", { name: nm, dir: dir.trim(), title: title.trim() || undefined });
    if (r.ok && r.data) { toast("项目创建成功", r.data.name ?? nm, "ok"); onClose(); onOpen(r.data.dir ?? dir.trim()); } else { toast("创建项目失败", r.errors?.[0]?.message, "error"); setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <h2 className="text-base font-semibold">新建项目</h2>
    <p className="text-muted leading-relaxed">项目就是磁盘上一个目录。选一个目录，它本身成为项目根；里面已有的稿件会被接管，不会被改动。</p>
    <Field label="目录" note={info && info.exists === false ? "目录还不存在，会自动创建" : cap.ok ? undefined : cap.why}><div className="flex gap-2"><input className={inputCls + " flex-1"} value={dir} onChange={(e) => setDir(e.target.value)} onBlur={() => void inspect(dir)} placeholder="/Users/…/我的项目" /><button className="btn" onClick={() => void pick()}>选择</button></div></Field>
    {info?.isProject && <div className="rounded border border-border bg-panel2 px-3 py-2 flex items-center gap-2"><span className="flex-1">这个目录已经是一个项目（有 project.json）。</span><button className="btn sm" onClick={() => { onClose(); onOpen(dir.trim()); }}>直接打开</button></div>}
    {info && !info.isProject && info.draftCount > 0 && <div className="rounded border border-border bg-panel2 px-3 py-2">这个目录里已有 {info.draftCount} 份稿。新建会把它们接管进项目，稿件不动，只加 project.json。</div>}
    <Field label="项目名" note={nameBad ? "只能用英文、数字、- 和 _，且以英文或数字开头" : "也是 MCP 里的项目标识"} err={nameBad}><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="英文 / 数字 / - _" /></Field>
    <Field label="标题"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给人看的名字，可选" /></Field>
    <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!dir.trim() || !nm || nameBad || !!info?.isProject || busy} onClick={() => void submit()}>{busy ? "正在建…" : "新建项目"}</button></div>
  </Sheet>;
}

/** 设置：外观三档 + 会话栏位置；项目级设置嵌 S8 壳（?embed=1，走本地 API） */

/** 通道 B 用哪个本地 CLI（M2-13）。
 *
 *  为什么值得有这一块：这些 CLI 走的是**登录态**而不是 API key —— 用户已经在付的订阅
 *  （Claude、Cursor、ChatGPT…）能直接用上，不必再按量买 token。
 *
 *  界面上要照实说三件事，都是实测出来的差异（`00` §六十五）：
 *  ① 没实测过的适配器标出来，别装得像验过；② 要不要往项目里写配置文件；
 *  ③ 报不报 token 用量（cursor-agent 不报，那「这一轮多贵」就是空的）。
 *  **密钥不在这里** —— 那个只在 ai_config.json 里手改。
 */
function CliPicker({ core }: { core: Core }) {
  const [rows, setRows] = useState<CliStatus[] | null>(null);
  const [cur, setCur] = useState<{ cli: string; model: string; via?: string } | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      core.get<{ clis: CliStatus[] }>("local_clis"),
      core.get<{ channelB?: { model: string; via?: string; cli?: string } | null }>("ai_config"),
    ]);
    if (a.ok && a.data) setRows(a.data.clis);
    const cb = b.ok ? b.data?.channelB : null;
    if (cb) { setCur({ cli: cb.cli ?? "claude", model: cb.model, via: cb.via }); setModel(cb.model); }
    setModels(null);
  }, [core]);
  useEffect(() => { void load(); }, [load]);

  const pick = async (cli: string, nextModel?: string) => {
    setBusy(true);
    const r = await core.post<{ cli: string; model: string; label: string; verified: boolean; note: string }>("ai_channel_b", { cli, model: nextModel ?? model });
    setBusy(false);
    if (!r.ok) { toast("没存上", r.errors?.[0]?.message ?? r.errors?.[0]?.fix, "error"); return; }
    toast(`通道 B 换成 ${r.data?.label}`, r.data?.verified ? undefined : "这个适配器还没在真机上验过", r.data?.verified ? "ok" : undefined);
    await load();
  };

  const sel = rows?.find((r) => r.id === (cur?.cli ?? "claude"));
  const askModels = async () => {
    if (!sel) return;
    setListing(true);
    const r = await core.get<{ models: string[] }>(`local_cli_models?cli=${encodeURIComponent(sel.id)}`);
    setListing(false);
    const ms = r.ok ? (r.data?.models ?? []) : [];
    setModels(ms);
    if (!ms.length) toast("列不出清单", `${sel.label} 没有「列模型」这条命令，或者它还没登录 —— 按 ${sel.modelHint} 的写法手填`);
  };
  return (
    <section className="rounded-lg border border-border bg-panel p-3 flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">通道 B · 本地 CLI</h3>
        <span className="text-[11px] text-muted flex-1">走 CLI 自己的登录态，用你已经在付的订阅，不按量买 token</span>
        <button className="btn sm ghost" onClick={() => void load()} title="重新扫一遍这台机器">重新扫描</button>
      </div>
      {!rows ? <div className="text-xs text-muted py-2">正在扫这台机器…</div> : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const on = r.id === (cur?.cli ?? "claude");
            return (
              <li key={r.id}>
                <button disabled={!r.installed || busy} onClick={() => void pick(r.id, r.id === cur?.cli ? model : "")}
                  className={`w-full text-left rounded border px-2.5 py-2 flex flex-col gap-1 transition-colors ${on ? "border-accent bg-accentSoft" : r.installed ? "border-border hover:border-borderStrong" : "border-border opacity-45 cursor-not-allowed"}`}>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`w-3 shrink-0 ${on ? "text-accent" : "text-muted"}`}>{on ? "●" : r.installed ? "○" : "·"}</span>
                    <b className="font-semibold">{r.label}</b>
                    <code className="text-[11px] text-muted font-mono">{r.bin}</code>
                    {r.version && <span className="text-[11px] text-muted font-mono truncate">{r.version}</span>}
                    <span className="flex-1" />
                    {!r.installed && <span className="lvl">没装</span>}
                    {r.installed && !r.verified && <span className="lvl" style={{ background: "var(--tool-warn-soft)", color: "var(--tool-warn)" }}>没实测过</span>}
                    {r.installed && r.verified && <span className="lvl" style={{ background: "var(--tool-ok-soft)", color: "var(--tool-ok)" }}>已实测</span>}
                    {r.output === "text" && <span className="lvl" title="没有 JSON 事件流，界面上看不到工具行">看不到工具行</span>}
                    {!r.reportsUsage && <span className="lvl" title="这条通道不报 token 用量">不报用量</span>}
                    {r.mcpVia === "workspace-file" && <span className="lvl" title="要在项目里落一个 MCP 配置文件">写项目文件</span>}
                    {r.mcpVia === "global-config" && <span className="lvl" title="要你自己往全局配置里加一次 MCP server">要手配 MCP</span>}
                  </div>
                  <p className="text-[11px] text-muted leading-relaxed pl-5">{r.installed ? r.note : r.loginHint}</p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {sel?.installed && (
        <div className="flex items-center gap-2 text-xs pt-0.5">
          <span className="text-muted shrink-0">模型</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => { if (model.trim() && model !== cur?.model) void pick(sel.id); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            list={models?.length ? "us-cli-models" : undefined}
            placeholder={sel.modelHint} className="flex-1 h-8 px-2.5 rounded border border-border bg-bg outline-none focus:border-accent font-mono" />
          {models?.length ? <datalist id="us-cli-models">{models.map((m) => <option key={m} value={m} />)}</datalist> : null}
          {sel.listModelsArgs && <button className="btn sm ghost" disabled={listing} onClick={() => void askModels()} title="问它有哪些模型可用（按账号来的，写死一定过时）">{listing ? "问着…" : models ? `${models.length} 个` : "列一下"}</button>}
          {cur?.via === "endpoint" && <span className="lvl" title="baseUrl / apiKey 填了，走的是你配的 Anthropic 兼容端点">走自配端点</span>}
        </div>
      )}
      <p className="text-[11px] text-muted leading-relaxed">
        密钥不在这里改 —— `.umbrastudio/ai_config.json` 手改（密钥属于机器，不经过界面和 HTTP）。
        登录要你自己在终端做一次：{sel?.loginHint ?? "见上面每一项的说明"}。
      </p>
    </section>
  );
}

export function SettingsSheet({ core, projectUrl, layout, setLayout, onClose }: { core: Core | null; projectUrl: string | null; layout: LayoutState; setLayout: (l: LayoutState) => void; onClose: () => void }) {
  const s8 = projectUrl ? `${projectUrl}${encodeURIComponent("S8-项目设置.dc.html")}?embed=1` : null;
  return <Sheet onClose={onClose} wide={!!s8}>
    <h2 className="text-base font-semibold">设置</h2>
    <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-3 items-center">
      <span className="text-muted">会话栏</span><div className="seg self-start"><button className={layout.chatSide === "left" ? "on" : ""} onClick={() => setLayout({ ...layout, chatSide: "left" })}>在左（默认）</button><button className={layout.chatSide === "right" ? "on" : ""} onClick={() => setLayout({ ...layout, chatSide: "right" })}>在右</button></div>
      <span className="text-muted">外观</span><div className="seg self-start">{(["system", "light", "dark"] as const).map((t) => <button key={t} className={layout.theme === t ? "on" : ""} onClick={() => setLayout({ ...layout, theme: t })}>{{ system: "跟随系统", light: "浅色", dark: "深色" }[t]}</button>)}</div>
    </div>
    {core && <CliPicker core={core} />}
    {s8 ? <iframe src={s8} title="项目设置" className="w-full border border-border rounded bg-panel" style={{ height: "min(600px, calc(100vh - 260px))" }} /> : <p className="text-muted">打开一个项目后，这里还有设计系统、限额、回收站与危险操作。</p>}
    <div className="flex justify-end"><button className="btn primary" onClick={onClose}>完成</button></div>
  </Sheet>;
}
