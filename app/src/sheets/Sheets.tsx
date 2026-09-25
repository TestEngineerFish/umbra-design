import { useCallback, useEffect, useState } from "react";
import type { Core } from "../api/client";
import { baseName, type CliStatus, type DirInfo } from "../api/types";
import type { HostAdapter } from "../host";
import type { LayoutState } from "../layout/layout";
import { currentChannel, pickChannel, type ChannelId } from "../chat/channel";
import { toast } from "../ui/Toast";

/** 弹窗外壳。
 *  **高度必须封顶 + 内容区能滚** —— 内容一多就撑出屏幕、底部按钮够不着，
 *  2026-09-24 用户实测撞到过（设置面板加了「本地 CLI」那一块之后）。
 *  所以这里是三段式：`<Sheet.Head>` 与 `<Sheet.Foot>` 钉住，中间那段自己滚。 */
function Sheet({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", on); return () => document.removeEventListener("keydown", on); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 bg-black/25 flex items-start justify-center p-4 sm:py-[6vh] overflow-hidden"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true"
        className={`bg-panel border border-border rounded-lg shadow-2xl flex flex-col text-xs max-h-full min-h-0 ${wide ? "w-[880px] max-w-full" : "w-[520px] max-w-full"}`}>
        {children}
      </div>
    </div>
  );
}
/** 钉在顶部的标题条 */
Sheet.Head = ({ children }: { children: React.ReactNode }) => (
  <div className="px-5 pt-5 pb-3 shrink-0">{children}</div>
);
/** 会滚的内容区 —— 弹窗里所有可能变长的东西都该放这里 */
Sheet.Body = ({ children }: { children: React.ReactNode }) => (
  <div className="px-5 flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">{children}</div>
);
/** 钉在底部的操作条：内容再长，「完成」也够得着 */
Sheet.Foot = ({ children }: { children: React.ReactNode }) => (
  <div className="px-5 pt-3 pb-5 shrink-0 flex justify-end gap-2 border-t border-border mt-4">{children}</div>
);
const Field = ({ label, children, note, err }: { label: string; children: React.ReactNode; note?: string; err?: boolean }) => <label className="flex flex-col gap-1"><span className="text-muted">{label}</span>{children}{note && <span className={err ? "text-err" : "text-muted"}>{note}</span>}</label>;
const inputCls = "h-8 px-3 rounded border border-border bg-bg outline-none focus:border-accent";

/** 新建稿件：走 create_draft（唯一写入口），建完自动选中 */
interface TemplateRow { id: string; name: string; sub?: string }

/** 新建稿件（M8-24 重画，形制按设计侧第八轮 §三）。
 *
 *  用户原话：「新建稿件的样式也不对，**太过拥挤**」。
 *  设计侧的诊断：拥挤是因为**四样东西排在同一个密度里**，没有层次。
 *  所以改成四组、组间 18px、每组一个小标题、控件高 34。
 *
 *  最要紧的一条是**文件名下面实时写出完整路径** ——
 *  「点『新建』之前就能知道结果」。重名或非法字符当场变红说原因，钮变灰。
 */
export function NewDraftSheet({ core, current, dir, onClose, onCreated }: {
  core: Core; current: string | null; dir: string; onClose: () => void; onCreated: (file: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"page" | "component">("page");
  const [tpl, setTpl] = useState("blank");
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void core.get<{ templates?: TemplateRow[] }>("templates").then((r) => setTemplates(r.data?.templates ?? [])).catch(() => {});
    void core.get<{ drafts?: Array<{ file: string }> }>("drafts").then((r) => setExisting((r.data?.drafts ?? []).map((d) => d.file))).catch(() => {});
  }, [core]);

  const n = name.trim();
  const fileName = n ? (n.endsWith(".dc.html") ? n : n + ".dc.html") : "";
  const full = fileName ? (dir ? `${dir}/${fileName}` : fileName) : "";
  const illegal = !!n && /[\\/:*?"<>|]/.test(n);
  const dup = !!full && existing.includes(full);
  const why = illegal ? '名字里不能有 \\ / : * ? " < > |' : dup ? "这个目录里已经有同名的稿了" : "";
  const blocked = !fileName || !!why || busy;

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    const body: Record<string, unknown> = { path: full, kind };
    if (tpl === "blank") body.source = "blank";
    else if (tpl.startsWith("copy:")) { body.source = "copy"; body.sourceFile = tpl.slice(5); }
    else { body.source = "template"; body.templateName = tpl; }
    const r = await core.post("create_draft", body);
    if (r.ok) { toast(`已新建 ${fileName}`, dir || "项目根", "ok"); onCreated(full); onClose(); }
    else { toast("新建稿件失败", r.errors?.[0]?.message, "error"); setBusy(false); }
  };

  return <Sheet onClose={onClose}>
    <div className="w-[460px] max-w-full grid gap-[18px]" onKeyDown={(e) => { if (e.key === "Enter" && !blocked) { e.preventDefault(); void submit(); } }}>
      <h2 className="text-base font-semibold">新建稿件</h2>

      <div className="grid gap-1.5">
        <label className="text-[11px] text-muted">文件名</label>
        <div className="flex items-center gap-0 h-[34px] rounded border bg-bg overflow-hidden" style={{ borderColor: why ? "var(--tool-err)" : "var(--tool-border)" }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：设置 · 账号与凭据"
            className="flex-1 min-w-0 h-full px-3 bg-transparent outline-none text-xs" />
          {/* 扩展名**固定显示在右边**，用户不用自己打 */}
          <span className="px-2.5 h-full grid place-items-center font-mono text-[11px] text-muted border-l border-border bg-panel2 shrink-0">.dc.html</span>
        </div>
        {/* 实时写出完整路径 —— 点「新建」之前就知道结果 */}
        <div className={`text-[11px] font-mono leading-relaxed break-all ${why ? "text-err" : "text-muted"}`}>
          {why || (full ? `将创建 ${full}` : "会自动补 .dc.html")}
        </div>
      </div>

      <div className="grid gap-1.5">
        <label className="text-[11px] text-muted">位置</label>
        <div className="h-[34px] px-3 flex items-center gap-2 rounded border border-border bg-panel2">
          <span className="flex-1 min-w-0 truncate font-mono text-[11px]">{dir || "项目根"}</span>
          <span className="text-[11px] text-muted shrink-0">右键哪个目录就建在哪</span>
        </div>
      </div>

      <div className="grid gap-1.5">
        <label className="text-[11px] text-muted">类型</label>
        <div className="grid grid-cols-2 gap-2">
          {([["page", "页稿", "一整屏，能演示、能当原型点"], ["component", "组件稿", "可被别的稿 import 的一块"]] as const).map(([k, label, sub]) => (
            <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k}
              className={`text-left p-2.5 rounded border transition-colors ${kind === k ? "border-accent bg-accentSoft" : "border-border hover:bg-hover"}`}>
              <div className={`text-xs font-semibold ${kind === k ? "text-accent" : ""}`}>{label}</div>
              <div className="text-[11px] text-muted leading-relaxed mt-0.5">{sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ 起始模板（第九轮 §十.2）═══
          **项目里一个模板都没有时整组不出** —— 那时它只剩「空白」和「复制现有稿」两项，
          是个空架子。「用户永远不知道有模板」这件事，解法放在**模板从哪来**的地方：
          `.dc.html` 的 `⋯` 里加了「存为模板…」，存过一次这一组就出现了。 */}
      {templates.length > 0 && (
        <div className="grid gap-1.5">
          <label className="text-[11px] text-muted">起始模板 · 可选</label>
          <div className="max-h-[132px] overflow-auto rounded border border-border divide-y divide-border">
            {[{ id: "blank", name: "空白", sub: "只有骨架和运行时" }, ...templates].map((t) => (
              <button key={t.id} onClick={() => setTpl(t.id)} aria-pressed={tpl === t.id}
                className={`w-full text-left px-2.5 py-2 flex items-center gap-2 hover:bg-hover ${tpl === t.id ? "bg-accentSoft" : ""}`}>
                <span className={`w-3 shrink-0 text-accent ${tpl === t.id ? "" : "opacity-0"}`}>✓</span>
                <span className="text-xs shrink-0">{t.name}</span>
                {t.sub && <span className="text-[11px] text-muted truncate">{t.sub}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* 「从现有稿复制…」**不能跟着整组一起消失**，所以它挪到底部成一个文字链 */}
        {current && (
          <button className={`text-[11px] underline underline-offset-2 ${tpl.startsWith("copy:") ? "text-accent" : "text-muted hover:text-text"}`}
            onClick={() => setTpl(tpl.startsWith("copy:") ? "blank" : `copy:${current}`)}
            title={tpl.startsWith("copy:") ? "点一下取消" : `复制 ${current}`}>
            {tpl.startsWith("copy:") ? `✓ 从 ${current.split("/").pop()} 复制` : "从现有稿复制…"}
          </button>
        )}
        <span className="flex-1" />
        <button className="btn" onClick={onClose}>取消 Esc</button>
        <button className="btn primary" disabled={blocked} onClick={() => void submit()}>{busy ? "正在建…" : "新建 ⏎"}</button>
      </div>
    </div>
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
  /* 当前通道用共用规则算（`chat/channel.ts`）—— **不要在这儿另判一遍**：
     「mem 没值就跟 defaultChannel」这条规则自己写一遍，就会和 useChat 对不上。 */
  const [channel, setChannel] = useState<ChannelId>(() => currentChannel(null));
  const pick2 = (c: ChannelId) => { setChannel(c); pickChannel(c); };
  const [rows, setRows] = useState<CliStatus[] | null>(null);
  const [cur, setCur] = useState<{ cli: string; model: string; via?: string } | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      core.get<{ clis: CliStatus[] }>("local_clis"),
      core.get<{ channelB?: { model: string; via?: string; cli?: string } | null; defaultChannel?: ChannelId }>("ai_config"),
    ]);
    if (a.ok && a.data) setRows(a.data.clis);
    const cb = b.ok ? b.data?.channelB : null;
    if (cb) { setCur({ cli: cb.cli ?? "claude", model: cb.model, via: cb.via }); setModel(cb.model); }
    // defaultChannel 要一起拿：没手动选过时当前通道就是它
    setChannel(currentChannel(b.ok ? b.data?.defaultChannel ?? null : null));
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
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="text-sm font-semibold shrink-0">通道 B · 本地 CLI</h3>
        <span className="text-[11px] text-muted flex-1 min-w-[12rem]">走 CLI 自己的登录态，用你已经在付的订阅，不按量买 token</span>
        <button className="btn sm ghost shrink-0" onClick={() => void load()} title="重新扫一遍这台机器">重新扫描</button>
      </div>
      {/* 这里配的是**通道 B 用哪个 CLI**，而会话栏此刻用的可能是别的通道 ——
          不把这个断层说出来，就会「我明明选了 Codex，左下角却还是通道 C」（用户实测撞到）。 */}
      {channel !== "b" && (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded text-[11px]"
          style={{ background: "var(--tool-warn-soft)", borderLeft: "2px solid var(--tool-warn)", color: "var(--tool-warn)" }}>
          <span className="flex-1">这里选的是<b>通道 B 用哪个 CLI</b>。会话栏现在用的是<b>通道 {channel.toUpperCase()}</b> —— 光在这儿选不会切过去。</span>
          <button className="btn sm shrink-0" onClick={() => { pick2("b"); toast("会话已切到通道 B", sel ? `用 ${sel.label}` : undefined, "ok"); }}>切到通道 B</button>
        </div>
      )}
      {channel === "b" && (
        <div className="text-[11px] text-muted">会话栏正用着通道 B —— 下面选的就是这一轮真正跑的那个。</div>
      )}
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
    <Sheet.Head><h2 className="text-base font-semibold">设置</h2></Sheet.Head>
    <Sheet.Body>
      <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-3 items-center">
        {/* 「会话栏在左 / 在右」这一项**删掉了**（M8-18）：会话栏固定在左，
            换边那一态在第八轮有意去掉了。三块区域的显隐在顶栏，不在设置里 ——
            那是每天要点好几次的东西，埋进设置面板不合适。 */}
        <span className="text-muted">外观</span><div className="seg self-start">{(["system", "light", "dark"] as const).map((t) => <button key={t} className={layout.theme === t ? "on" : ""} onClick={() => setLayout({ ...layout, theme: t })}>{{ system: "跟随系统", light: "浅色", dark: "深色" }[t]}</button>)}</div>
      </div>
      {core && <CliPicker core={core} />}
      {/* iframe 的高度给固定值，别用 vh —— 它在会滚的内容区里，用 vh 会和外层的滚动打架 */}
      {s8 ? <iframe src={s8} title="项目设置" className="w-full border border-border rounded bg-panel shrink-0" style={{ height: 560 }} />
        : <p className="text-muted">打开一个项目后，这里还有设计系统、限额、回收站与危险操作。</p>}
    </Sheet.Body>
    <Sheet.Foot><button className="btn primary" onClick={onClose}>完成</button></Sheet.Foot>
  </Sheet>;
}
