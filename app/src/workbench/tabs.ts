import { dirtyStore } from "../ui/dirty";

/** 页签的三态（M8-28，形制按设计侧第九轮 §六）。
 *
 *  用户原话：「不应每次查看一个详情就多新增一个，如果当前查看的详情**不是固定的**，
 *  也**不是有修改未保存的**，则直接覆盖当前查看的详情」。这是编辑器里的「预览页签」。
 *
 *  | 态 | 怎么来 | 长什么样 |
 *  | --- | --- | --- |
 *  | 预览 | 目录里**单击**文件 | 名字用 `text-2`、不加粗、图标灰。**同一时间最多一个** |
 *  | 打开 | 双击页签 · 双击目录里的文件 · 开始改内容 · 展开编辑栏 · 右键「保持打开」 | 普通页签 |
 *  | 固定 | 右键「固定」 | 排最左、最宽 150、关闭钮的位置换成图钉 |
 *
 *  ⚠️ **不用斜体**区分预览态 —— 中文字体没有斜体，浏览器会硬斜切，很难看
 *  （设计侧特意写了这一条）。浅一档的颜色加不加粗已经够。
 */
export interface Tab {
  path: string;
  /** 预览态：下一次单击别的文件会盖掉它 */
  preview?: boolean;
  /** 固定：排最左，不会被「关闭其他」关掉 */
  pinned?: boolean;
}

/** 老的 `string[]` 存量（M8-28 之前）也要认 */
export function normalize(raw: unknown): Tab[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (typeof x === "string" ? { path: x } : x)).filter((t): t is Tab => !!t && typeof t.path === "string");
}

/** 排序：固定的永远在最左，其余保持打开顺序 */
export function ordered(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** 一份文件**能不能被预览态盖掉**：固定的不行，改了没落盘的不行。 */
export function replaceable(t: Tab): boolean {
  return !!t.preview && !t.pinned && !dirtyStore.has(t.path);
}

/** 打开一份文件。
 *
 *  `mode: "preview"`（单击）会**盖掉现有的预览页签** —— 这是用户要的「不要每看一个就多一个」。
 *  盖不掉的（固定 / 未保存）永远不会被盖，这时候新开一个预览页签。
 */
export function openTab(tabs: Tab[], path: string, mode: "preview" | "open"): Tab[] {
  const has = tabs.find((t) => t.path === path);
  if (has) {
    /* 已经开着：双击 / 明确打开会把预览态转正，单击不动它 */
    return mode === "open" && has.preview ? tabs.map((t) => (t.path === path ? { ...t, preview: false } : t)) : tabs;
  }
  if (mode === "open") return [...tabs, { path }];
  const idx = tabs.findIndex(replaceable);
  if (idx < 0) return [...tabs, { path, preview: true }];
  const next = [...tabs];
  next[idx] = { path, preview: true };
  return next;
}

/** 「关闭其他 / 右侧 / 已保存的」会关掉几个 —— 菜单里要**写出真会关掉的个数**，
 *  「点之前就知道结果」（设计侧 §六.2）。一个都关不掉时那一项置灰。 */
export function closable(tabs: Tab[], scope: "others" | "right" | "saved", current: string): Tab[] {
  const keep = (t: Tab) => t.pinned || dirtyStore.has(t.path);
  if (scope === "others") return tabs.filter((t) => t.path !== current && !keep(t));
  if (scope === "saved") return tabs.filter((t) => !keep(t));
  const i = tabs.findIndex((t) => t.path === current);
  return i < 0 ? [] : tabs.slice(i + 1).filter((t) => !keep(t));
}
