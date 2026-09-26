import { z } from "zod";
import { join } from "node:path";
import { envelope } from "../envelope.js";
import { createDraft, createFolder, duplicateDraft } from "../project.js";
import {
  deleteDraft, deleteDraftImpact, emptyTrash, listTrash, moveDraft, purgeTrash, renameDraft, restoreDraft,
} from "../refs.js";
import { defineCap } from "./registry.js";
import type { CapCtx } from "./types.js";

/** 稿件生命周期（M11-7 第一批搬）。
 *
 *  ⚠️ **搬这一组当场抓到一个真缺陷**：HTTP 侧的 `create_draft` **不认 `source: "template"`** ——
 *  前端选模板新建时发的正是它，于是掉进 `blank` 分支，**建出来是空白稿**，
 *  而界面只说「已新建」。实测返回里明写着 `source: "空白骨架"`。
 *  MCP 侧一直是对的 —— 两个门面各写一遍，只有一边补了模板这一档。
 *
 *  这就是 Q36 要解决的病：不是「文件太长」，是**同一件事有两份实现，只有一份被修过**。
 */
const p = (c: CapCtx) => c.project!;

/** 模板名 → 绝对路径。模板存在项目自己的 `.umbrastudio/templates/` 下 */
const tplPath = (dir: string, name: string) => join(dir, ".umbrastudio", "templates", `${name}.dc.html`);

defineCap({
  name: "create_draft", title: "新建一份设计稿", scope: "project",
  summary: [
    "按四种来源之一建稿：空白骨架 / 复制现有稿 / 包装一个组件 / 套模板。",
    "走的是唯一写入口（归一化 → @ds 展开 → __resources 注入 → 快照），所以断网也能打开。",
  ].join("\n"),
  input: {
    path: z.string().describe("相对项目根的路径，必须以 .dc.html 结尾"),
    source: z.enum(["blank", "copy", "component", "template"]).describe("稿的来源"),
    title: z.string().optional().describe("空白稿或组件包装稿的标题，不给时用文件名"),
    sourceFile: z.string().optional().describe("source=copy 时的源稿路径（相对项目根）"),
    componentName: z.string().optional().describe("source=component 时的组件名（dc-import name）"),
    templatePath: z.string().optional().describe("source=template 时的模板绝对路径"),
    templateName: z.string().optional().describe("source=template 时的模板名（list_templates 可查）"),
  },
  http: { method: "POST" },
  run: async ({ path, source, title, sourceFile, componentName, templatePath, templateName }, c) => {
    const proj = p(c);
    let src;
    switch (source) {
      case "copy":
        if (!sourceFile) throw new Error("source=copy 时必须传 sourceFile");
        src = { kind: "copy" as const, sourceFile };
        break;
      case "component":
        if (!componentName) throw new Error("source=component 时必须传 componentName");
        src = { kind: "component" as const, componentName, title };
        break;
      case "template": {
        /* ⚠️ **这一档 HTTP 侧原来没有**（见文件头）。两个门面合成一份之后，
           两边都有了 —— 这正是搬过来的意义。 */
        const t = templatePath ?? (templateName ? tplPath(proj.dir, templateName) : undefined);
        if (!t) throw new Error("source=template 时必须传 templatePath 或 templateName");
        src = { kind: "template" as const, templatePath: t };
        break;
      }
      default:
        src = { kind: "blank" as const, title };
    }
    return envelope(await createDraft(proj, path, src));
  },
});

defineCap({
  name: "rename_draft", title: "给稿改名", scope: "project",
  summary: "改名并**把引用它的稿一起改写**。所以不要用系统的文件管理器改名 —— 那样引用会断。",
  input: { path: z.string().describe("当前稿的相对路径"), newName: z.string().describe("新基名，不用加 .dc.html") },
  http: { method: "POST" },
  run: async ({ path, newName }, c) => {
    const r = await renameDraft(p(c), path, newName);
    return envelope(r, [], { referencesUpdated: r.referencesUpdated });
  },
});

defineCap({
  name: "duplicate_draft", title: "复制一份稿", scope: "project",
  summary: "复制成新稿。不给新名就是「<原名> 副本」。",
  input: { path: z.string(), newName: z.string().optional() },
  http: { method: "POST" },
  run: async ({ path, newName }, c) => {
    const r = await duplicateDraft(p(c), path, newName ? { newName } : {});
    return envelope(r, [], { newPath: r.newPath });
  },
});

defineCap({
  name: "move_draft", title: "把稿移到别的目录", scope: "project",
  summary: "移动并**把引用它的稿一起改写**。同 rename_draft：不要用文件管理器搬。",
  input: { path: z.string(), targetDir: z.string().describe("目标目录相对项目根的路径") },
  http: { method: "POST" },
  run: async ({ path, targetDir }, c) => {
    const r = await moveDraft(p(c), path, targetDir);
    return envelope(r, [], { referencesUpdated: r.referencesUpdated });
  },
});

defineCap({
  name: "create_folder", title: "新建目录", scope: "project",
  summary: "在项目里建一个目录。稿按目录分组，目录本身不是稿。",
  input: { path: z.string().describe("目录相对项目根的路径，如 Components 或 Pages/子目录") },
  /* HTTP 侧原来叫 `dir_create`（资源在前），前端在用，保留 */
  http: { route: "dir_create", method: "POST" },
  run: async ({ path }, c) => envelope(await createFolder(p(c), path)),
});

defineCap({
  name: "get_delete_impact", title: "删之前先看影响面", scope: "project",
  summary: "谁引用了这份稿。**删之前必看** —— 有人引用还删，那些稿会缺资源。",
  input: { path: z.string() },
  http: { route: "delete_impact", method: "GET" },
  run: async ({ path }, c) => {
    const impact = await deleteDraftImpact(p(c), path);
    return envelope(impact, [], { affectedCount: impact.affectedCount });
  },
});

defineCap({
  name: "delete_draft", title: "把稿移进回收站", scope: "project",
  summary: "不是真删 —— 进项目的回收站，可以恢复。建议先用 get_delete_impact 看影响面。",
  input: { path: z.string() },
  http: { method: "POST" },
  run: async ({ path }, c) => {
    const r = await deleteDraft(p(c), path);
    return envelope(r, [], { trashPath: r.trashPath });
  },
});

defineCap({
  name: "list_trash", title: "回收站里有什么", scope: "project",
  summary: "列回收站：原路径、删除时间、回收站路径。恢复要用它给的 trashPath。",
  input: {},
  http: { route: "trash", method: "GET" },
  run: async (_i, c) => {
    const items = await listTrash(p(c));
    return envelope({ items }, [], { count: items.length });
  },
});

defineCap({
  name: "restore_draft", title: "从回收站恢复", scope: "project",
  summary: "按 list_trash 给的 trashPath 恢复。原位置已被占用时会换个名字，不会覆盖。",
  input: { trashPath: z.string().describe("回收站路径，list_trash 给的那个") },
  /* ⚠️ HTTP 侧原来有**两条**做重叠的事：`restore_draft`（按文件名在回收站里找）
     和 `trash_restore`（按 trashPath）。合成这一条，**按 trashPath** ——
     按文件名找会在同名多次删除时选错那一份，而那是静默的。 */
  http: { route: "trash_restore", method: "POST" },
  run: async ({ trashPath }, c) => {
    const r = await restoreDraft(p(c), trashPath);
    return envelope(r, [], { restored: r.originalPath });
  },
});

defineCap({
  name: "purge_trash", title: "永久删掉回收站里的一项", scope: "project",
  summary: "**真删，退不回来**。删之前想清楚。",
  input: { trashPath: z.string() },
  http: { route: "trash_purge", method: "POST" },
  run: async ({ trashPath }, c) => envelope(await purgeTrash(p(c), trashPath)),
});

defineCap({
  name: "empty_trash", title: "清空回收站", scope: "project",
  summary: "**真删，全部退不回来**。",
  input: {},
  http: { route: "trash_empty", method: "POST" },
  run: async (_i, c) => envelope(await emptyTrash(p(c))),
});
