import { useCallback, useEffect, useRef, useState } from "react";
import type { Core } from "../api/client";
import type { Draft, FileEntry, Health, ListFilesResult } from "../api/types";
import { Glyph, ICON } from "../ui/Glyph";
import { kindDef } from "@shared/kinds";

/** 常驻目录列里的那棵树（M8-11，形制按设计侧第六轮的 S11 窄列 / S12）。
 *
 *  和 `DirView` 的分工：这里是**导航**，一直在，只放名称和一个状态点；
 *  `DirView`（S12 宽区）是**干活的地方**，有勾选框、读数、网格。两边共用同一个 `expanded`。
 *
 *  尺寸是设计侧定的一套，别各改各的：
 *  每层缩进 16px（正好是三角的宽度，所以子项的三角落在父项图标正下方）、
 *  三角 16px、类型图标 14px、行高 28px。**不画层级线** —— 层级靠缩进和三角对位表达。
 */
const INDENT = 16, ROW_H = 28;

/* 图标问 `@shared/kinds`，这里不留第二张表（M8-14） */

export interface TreeProps {
  core: Core;
  /** 当前在详情区打开的文件（相对路径），用来高亮 + 自动展开祖先 */
  current: string | null;
  /** 哪些目录是展开的 —— 存在 layout 里，和 DirView 共用 */
  expanded: string[];
  onExpandedChange: (next: string[]) => void;
  /** 单击文件 / 双击目录（双击是「在详情区以它为根打开」） */
  onOpenFile: (path: string) => void;
  onOpenDir: (path: string) => void;
  /** 稿件的健康：有提醒或错误才挂点，「通过」不挂（设计侧口径） */
  healthOf: (path: string) => Health | null;
  /** 列头显示的项目名，点它回到根 */
  projectName: string;
  /** 「转到文件」用的稿件表（⌘P）。列头上的这两颗钮都是**导航动作**，
   *  第七轮把它们从页签条挪到这儿 —— 页签条只管「开着哪些文件」。 */
  drafts: Draft[];
  indexed: boolean;
  /** 收起这一列。展开钮在页签条最左（同一图标、箭头反向） */
  onCollapse: () => void;
  /** 文件变动的信号（传最近一次事件的时刻即可）：变了就把已展开的层重新拉一遍 */
  tick: string;
}

export function FileTree({ core, current, expanded, onExpandedChange, onOpenFile, onOpenDir, healthOf, projectName, drafts, indexed, onCollapse, tick }: TreeProps) {
  const [goto, setGoto] = useState(false);
  const [q, setQ] = useState("");
  /* 每一层的内容按需拉，拉过就留在内存里。`children[path] === undefined` = 还没拉过，
     这和后端约定的「children 缺省表示未拉取、[] 表示空目录」是同一套语义。 */
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const expSet = new Set(expanded);

  const load = useCallback(async (dir: string) => {
    setLoading((s) => new Set(s).add(dir));
    const r = await core.get<ListFilesResult>(`files?dir=${encodeURIComponent(dir)}`);
    setLoading((s) => { const n = new Set(s); n.delete(dir); return n; });
    if (r.ok && r.data) setChildren((c) => ({ ...c, [dir]: r.data!.entries }));
  }, [core]);

  /* 挂载时除了根，**还要把已经展开的那些层一起拉回来**。
     `expanded` 存在 layout 里能活过卸载，而 `children` 是组件内的内存缓存，
     ⌘B 收起时整棵树卸载、缓存就没了 —— 不补这一步，再展开会看到
     「三角是展开的、底下一个子项都没有」（2026-09-24 截图里抓到的，自动测试当时没测出来）。 */
  useEffect(() => {
    void load("");
    for (const d of expanded) void load(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  /* 盘上变了就重拉**已经展开的那些层** —— 只重拉根会让展开着的子目录显示旧内容。
     没展开的层等下次展开时自然是新的。 */
  useEffect(() => {
    if (!tick) return;
    for (const d of ["", ...expanded]) if (children[d] !== undefined) void load(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  /* 打开一个文件时，把它的祖先自动展开 —— 不然用户点了页签，树里却看不见它在哪 */
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    if (!current || current === lastCurrent.current) return;
    lastCurrent.current = current;
    const parts = current.split("/").slice(0, -1);
    const need: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (!expSet.has(p)) need.push(p);
    }
    if (need.length) onExpandedChange([...expanded, ...need]);
    for (const p of need) if (children[p] === undefined) void load(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    const on = () => { setGoto(true); setQ(""); };
    window.addEventListener("ud-goto-file", on); return () => window.removeEventListener("ud-goto-file", on);
  }, []);

  const toggle = (path: string) => {
    const next = expSet.has(path) ? expanded.filter((x) => x !== path) : [...expanded, path];
    onExpandedChange(next);
    if (!expSet.has(path) && children[path] === undefined) void load(path);
  };

  const rows = (dir: string, depth: number): React.ReactNode[] => {
    const list = children[dir];
    if (list === undefined) return [];
    if (list.length === 0) return [<Empty key={dir + ":empty"} depth={depth} text="空目录" />];
    const out: React.ReactNode[] = [];
    for (const e of list) {
      const open = expSet.has(e.path);
      const isCur = e.path === current;
      const h = e.isDir ? null : healthOf(e.path);
      out.push(
        <div key={e.path} role="treeitem" aria-expanded={e.isDir ? open : undefined} aria-selected={isCur}
          className={`flex items-center gap-1.5 pr-2 cursor-pointer select-none ${isCur ? "bg-accentSoft text-accent font-semibold" : "hover:bg-hover"}`}
          style={{ height: ROW_H, paddingLeft: 6 + depth * INDENT }}
          title={e.path}
          onClick={() => (e.isDir ? toggle(e.path) : onOpenFile(e.path))}
          onDoubleClick={() => { if (e.isDir) onOpenDir(e.path); }}>
          {/* 三角占位：文件也占同样宽度，图标才对得齐 */}
          <span className="w-4 shrink-0 text-[10px] text-muted grid place-items-center transition-transform"
            style={{ transform: e.isDir && open ? "rotate(90deg)" : "none" }}>{e.isDir ? "▶" : ""}</span>
          <span className={`w-[14px] shrink-0 text-center text-[13px] ${isCur ? "text-accent" : e.kind === "dc" ? "text-accent" : "text-muted"}`}>
            {kindDef(e.isDir ? "dir" : e.kind).icon}
          </span>
          <span className="truncate flex-1 text-xs leading-none">{e.name}</span>
          {/* 「通过」不挂点（设计侧口径：只有该看的才出现）。
              TODO 未落盘的 warn 点：前端目前拿不到这个信号，等 S1 那套 hasUnsaved 接到工作台再补 */}
          {h && h !== "ok" && h !== "unchecked" && <span className={`hdot ${h} shrink-0`} title={h === "error" ? "有错误" : "有提醒"} />}
        </div>,
      );
      if (e.isDir && open) {
        if (loading.has(e.path) && children[e.path] === undefined) out.push(<Loading key={e.path + ":ld"} depth={depth + 1} />);
        else out.push(...rows(e.path, depth + 1));
      }
    }
    return out;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 列头：项目名（点回根）+ 两颗导航钮。钮常驻不 hover 才出 —— 键盘和触控都要够得着 */}
      {/* 高度和分隔线都跟页签条对齐（34px + border-b）——
          目录列通栏之后它和页签条并排，差 2px 或少一条线，那条横线就是断的 */}
      <div data-ud="tree-head" className="h-[34px] pl-2.5 pr-1 flex items-center gap-1 shrink-0 text-xs relative border-b border-border">
        <button className="min-w-0 flex-1 flex items-center gap-1.5 h-6 px-1 rounded font-semibold hover:bg-hover text-left"
          onClick={() => onOpenDir("")} title="回到项目根">
          <span className="text-muted shrink-0">{kindDef("dir").icon}</span><span className="truncate">{projectName}</span>
        </button>
        <button className="w-6 h-6 grid place-items-center rounded text-muted hover:bg-hover hover:text-text shrink-0"
          onClick={() => { setGoto((g) => !g); setQ(""); }} title="转到文件（⌘P）" aria-label="转到文件">
          <Glyph d={ICON.search} size={13} />
        </button>
        {/* 第八轮把 `⤢ 铺到详情区` **删掉了** —— 用户把它读成了「放大 / 展开」，
            而且点了之后详情区出现目录列表，他恰恰抱怨过「预览不该和目录显示重复内容」。
            那个功能留在三个入口：右键目录 · 双击目录 · 点列头的项目名。
            这个位置换成他真正期望的**收起目录列**。 */}
        <button data-ud="tree-collapse" className="w-6 h-6 grid place-items-center rounded text-muted hover:bg-hover hover:text-text shrink-0"
          onClick={onCollapse} title="收起目录列（⌘B）" aria-label="收起目录列">
          <Glyph d={ICON.treeCollapse} size={13} />
        </button>
        {goto && <GotoFile q={q} setQ={setQ} drafts={drafts} indexed={indexed} current={current}
          onPick={(f) => { setGoto(false); onOpenFile(f); }} onClose={() => setGoto(false)} />}
      </div>
      <div className="flex-1 min-h-0 overflow-auto pb-2" role="tree">
        {children[""] === undefined ? <Loading depth={0} /> : rows("", 0)}
      </div>
    </div>
  );
}

/** 「转到文件」浮层。原来是页签条右边那颗「N 份稿 ▾」——
 *  按第七轮的分层，它变的是「在详情区看哪份文件」，属于导航，所以跟着目录列走。 */
function GotoFile({ q, setQ, drafts, indexed, current, onPick, onClose }: {
  q: string; setQ: (v: string) => void; drafts: Draft[]; indexed: boolean; current: string | null;
  onPick: (file: string) => void; onClose: () => void;
}) {
  const kw = q.trim().toLowerCase();
  const rows = drafts.filter((d) => !kw || `${d.title} ${d.file}`.toLowerCase().includes(kw));
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div className="absolute left-1 right-1 top-[34px] z-[41] max-h-[60vh] flex flex-col bg-panel border border-borderStrong rounded-lg shadow-2xl overflow-hidden">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="转到文件…"
          className="m-1.5 h-7 px-2 rounded border border-borderStrong bg-bg outline-none focus:border-accent text-xs"
          onKeyDown={(e) => {
            if (e.key === "Escape") { if (q) setQ(""); else onClose(); }
            if (e.key === "Enter" && rows[0]) onPick(rows[0].file);
          }} />
        <div className="flex-1 overflow-auto pb-1">
          {rows.length ? rows.map((d) => (
            <button key={d.file} className={`w-full px-2 py-1 flex items-center gap-2 text-left hover:bg-hover ${d.file === current ? "bg-accentSoft" : ""}`} onClick={() => onPick(d.file)}>
              <span className={`hdot ${d.health}`} title={d.healthWhy} />
              <span className="truncate flex-1 text-xs">{d.title}</span>
              <span className="text-muted font-mono text-[11px] shrink-0">{d.version ?? ""}</span>
            </button>
          )) : <div className="px-2 py-3 text-muted text-[11px] text-center">没有匹配的稿</div>}
        </div>
        {!indexed && <div className="px-2 h-7 flex items-center border-t border-border text-[11px] text-muted">还没建索引 —— 项目菜单里「重建索引」</div>}
      </div>
    </>
  );
}

const Loading = ({ depth }: { depth: number }) => (
  <div className="flex items-center gap-1.5 text-[11px] text-muted" style={{ height: ROW_H, paddingLeft: 6 + depth * INDENT + 20 }}>
    <span className="inline-block w-3 h-3 rounded-full border border-current border-t-transparent animate-spin" />读取中…
  </div>
);
const Empty = ({ depth, text }: { depth: number; text: string }) => (
  <div className="text-[11px] text-muted" style={{ height: ROW_H, lineHeight: `${ROW_H}px`, paddingLeft: 6 + depth * INDENT + 20 }}>{text}</div>
);
