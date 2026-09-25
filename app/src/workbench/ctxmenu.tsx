import { PopItem, PopSep, PopoverAt } from "../ui/Popover";
import type { Core } from "../api/client";
import type { HostAdapter } from "../host";
import { toast } from "../ui/Toast";

/** 目录的右键菜单（M8-21，形制按设计侧第八轮 §五）。
 *
 *  **目录列（S11）和目录视图（S12）共用这一份** —— 设计侧原话「和 S11 目录列同一套」。
 *  写两遍的话，改一处忘一处的老毛病马上就回来了。
 *
 *  菜单按**右键点在什么上**分三种，这是它给的判据：
 *  - **新建只出现在目录和空白处** —— 只有这两处能回答「建在哪」。
 *    在文件上右键不出新建，否则就得猜是建在它旁边还是别处。
 *  - **重建索引只出现在空白处** —— 它作用于整个项目，空白处就是项目根。
 *    右键某个目录时出现它，会让人以为只重建这一个目录。
 *  - **删除不弹确认**，菜单里直接写「移到回收站」，写的是它实际做的事，
 *    也说明了可以恢复（沿用 S1 行内撤销那一套口径）。
 */
export type CtxTarget =
  | { kind: "dir"; path: string; name: string }
  | { kind: "file"; path: string; name: string; isDraft: boolean }
  | { kind: "blank" }
  | { kind: "multi"; paths: string[] };

export interface CtxItem { label: string; hint?: string; danger?: boolean; run?: () => void }
const SEP: CtxItem = { label: "—" };

export interface CtxActions {
  newDraft: (dir: string) => void;
  newFolder: (dir: string) => void;
  openInDetail: (dir: string) => void;
  openFile: (path: string) => void;
  toChat: (paths: string[]) => void;
  rename: (path: string) => void;
  duplicate: (path: string) => void;
  trash: (paths: string[]) => void;
  collapseAll: () => void;
  rebuildIndex: () => void;
  reveal: (path: string) => void;
  copyPath: (path: string) => void;
}

export function itemsFor(t: CtxTarget, a: CtxActions): CtxItem[] {
  if (t.kind === "multi") {
    /* 多选：只剩批量做得了的事 —— 没有重命名（一次只能改一个）、没有新建（建在哪说不清） */
    return [
      { label: `带进会话（${t.paths.length} 项）`, run: () => a.toChat(t.paths) },
      { label: "复制路径", run: () => a.copyPath(t.paths.join("\n")) },
      SEP,
      { label: `移到回收站（${t.paths.length} 项）`, hint: "⌘⌫", danger: true, run: () => a.trash(t.paths) },
    ];
  }
  if (t.kind === "blank") {
    return [
      { label: "新建稿件…", run: () => a.newDraft("") },
      { label: "新建目录", run: () => a.newFolder("") },
      SEP,
      { label: "全部折叠", run: a.collapseAll },
      SEP,
      { label: "重建索引", run: a.rebuildIndex },
      { label: "在访达中显示", run: () => a.reveal("") },
    ];
  }
  if (t.kind === "dir") {
    return [
      { label: "新建稿件…", run: () => a.newDraft(t.path) },
      { label: "新建目录", run: () => a.newFolder(t.path) },
      SEP,
      { label: "在详情区打开", run: () => a.openInDetail(t.path) },
      { label: "带进会话", run: () => a.toChat([t.path]) },
      SEP,
      { label: "重命名", hint: "F2", run: () => a.rename(t.path) },
      { label: "复制路径", run: () => a.copyPath(t.path) },
      { label: "在访达中显示", run: () => a.reveal(t.path) },
      SEP,
      { label: "移到回收站", hint: "⌘⌫", danger: true, run: () => a.trash([t.path]) },
    ];
  }
  return [
    { label: "打开", run: () => a.openFile(t.path) },
    { label: "带进会话", run: () => a.toChat([t.path]) },
    SEP,
    { label: "重命名", hint: "F2", run: () => a.rename(t.path) },
    ...(t.isDraft ? [{ label: "复制一份", run: () => a.duplicate(t.path) }] : []),
    { label: "复制路径", run: () => a.copyPath(t.path) },
    { label: "在访达中显示", run: () => a.reveal(t.path) },
    SEP,
    { label: "移到回收站", hint: "⌘⌫", danger: true, run: () => a.trash([t.path]) },
  ];
}

/** 右键菜单 = 位置跟着鼠标的浮层。定位、翻转、外部点击、Esc 全在 `ui/Popover` 里（M8-25）。 */
export function CtxMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  return (
    <PopoverAt x={x} y={y} onClose={onClose} tag="ctxmenu">
      <div>
        {items.map((it, i) => it.label === "—"
          ? <PopSep key={i} />
          : <PopItem key={i} label={it.label} hint={it.hint} danger={it.danger}
              onPick={it.run ? () => { onClose(); it.run!(); } : undefined} />)}
      </div>
    </PopoverAt>
  );
}

/** 菜单项背后的动作，做成一份 —— 目录列和目录视图接的是同一套后端调用 */
export function makeActions(opts: {
  core: Core; host: HostAdapter; projectDir: string;
  onOpenFile: (p: string) => void; onOpenDir: (p: string) => void;
  onToChat: (paths: string[]) => void; onRename: (p: string) => void;
  onNewDraft: (dir: string) => void; onCollapseAll: () => void;
  onTrashed: (paths: string[]) => void; onRebuildIndex: () => void; refresh: () => void;
}): CtxActions {
  const { core, host, projectDir } = opts;
  return {
    newDraft: opts.onNewDraft,
    newFolder: (dir) => {
      /* 新建目录用的是**就地输入**那一套的简化版：先问名字。
         设计侧没画这一屏，这里用最轻的做法，等它给形制再换。【判断】 */
      const name = window.prompt("新目录的名字", "新建目录");
      if (!name) return;
      void core.post("dir_create", { path: dir ? `${dir}/${name}` : name }).then((r) => {
        if (!r.ok) { toast("建不了", r.errors?.[0]?.message, "error"); return; }
        toast("已新建目录", dir ? `${dir}/${name}` : name, "ok");
        opts.refresh();
      });
    },
    openInDetail: opts.onOpenDir,
    openFile: opts.onOpenFile,
    toChat: opts.onToChat,
    rename: opts.onRename,
    duplicate: (path) => {
      void core.post<{ file: string }>("duplicate_draft", { path }).then((r) => {
        if (!r.ok) { toast("复制不了", r.errors?.[0]?.message, "error"); return; }
        toast("已复制一份", r.data?.file, "ok");
        opts.refresh();
      });
    },
    trash: opts.onTrashed,
    collapseAll: opts.onCollapseAll,
    rebuildIndex: opts.onRebuildIndex,
    reveal: (path) => void host.revealInFinder(path ? `${projectDir}/${path}` : projectDir).catch((e: Error) => toast("打不开", e.message, "error")),
    copyPath: (path) => void navigator.clipboard?.writeText(path.includes("\n") ? path : `${projectDir}/${path}`)
      .then(() => toast("路径已复制", undefined, "ok"), () => toast("复制不了", "浏览器不让访问剪贴板", "error")),
  };
}
