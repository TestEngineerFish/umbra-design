/* Umbra 图标表 · 第九轮
   16 × 16 网格，活动区 2.5–13.5；线宽一律 1.4，圆端点、圆转角；只描边不填色。
   容器（框、页、夹）圆角 1.5；点状元素用 r0.75 小圆（更多）或零长线段（感叹号、i 的点）。
   只在 16 和 12 两个尺寸出现：16 是默认，12 只给触发器上的小箭头和页签的 ×。
   window.UMBRA_ICONS[name] = d；window.UMBRA_ICON_GROUPS 给 S16 图标表排版用。 */
(function () {
  const n = (v) => +v.toFixed(2);
  const rr = (x, y, w, h, r) => {
    r = r == null ? 1.5 : r;
    const iw = n(w - 2 * r), ih = n(h - 2 * r);
    return "M" + n(x + r) + " " + y + "h" + iw + "a" + r + " " + r + " 0 0 1 " + r + " " + r + "v" + ih +
      "a" + r + " " + r + " 0 0 1 -" + r + " " + r + "h-" + iw + "a" + r + " " + r + " 0 0 1 -" + r + " -" + r +
      "v-" + ih + "a" + r + " " + r + " 0 0 1 " + r + " -" + r + "z";
  };
  const circ = (cx, cy, r) => "M" + cx + " " + n(cy - r) + "a" + r + " " + r + " 0 1 0 0 " + n(2 * r) + "a" + r + " " + r + " 0 1 0 0 -" + n(2 * r) + "z";
  const PAGE = "M9.5 2.5H4.5A1.5 1.5 0 0 0 3 4v8a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12V6zM9.5 2.5V6H13";
  const FRAME = rr(2.5, 3, 11, 10);
  const PLUG = "M6 2.5V5M10 2.5V5M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v2.5";

  const ICONS = {
    "file": PAGE,
    "file-dc": PAGE + rr(5.5, 8, 5, 3.5, 0.75),
    "file-comp": "M8 2.2l5 2.9v5.8L8 13.8l-5-2.9V5.1z",
    "file-md": PAGE + "M5.5 8.5h5M5.5 11h3",
    "file-image": FRAME + "M2.5 11.5l3.2-3.2 2.6 2.6 1.7-1.7 3.5 3.3" + circ(10.5, 6, 0.9),
    "file-json": PAGE + "M6.8 7.5c-.7 0-1 .3-1 .9v.6c0 .3-.2.5-.6.6.4.1.6.3.6.6v.6c0 .6.3.9 1 .9M9.2 7.5c.7 0 1 .3 1 .9v.6c0 .3.2.5.6.6-.4.1-.6.3-.6.6v.6c0 .6-.3.9-1 .9",
    "file-code": PAGE + "M6.8 8L5.5 9.5 6.8 11M9.2 8l1.3 1.5L9.2 11",
    "file-web": PAGE + circ(8, 9.5, 2) + "M6 9.5h4",
    "folder": "M2.5 5A1.5 1.5 0 0 1 4 3.5h2.3l1.5 1.5H12A1.5 1.5 0 0 1 13.5 6.5v5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z",
    "folder-open": "M2.5 11.5V5A1.5 1.5 0 0 1 4 3.5h2.3l1.5 1.5H11a1.5 1.5 0 0 1 1.5 1.5v1M2.5 11.5l1.4-3.3a1 1 0 0 1 .9-.7h8.3a.6.6 0 0 1 .55.85L12.3 12.4a1 1 0 0 1-.9.6H4a1.5 1.5 0 0 1-1.5-1.5z",

    "region-tree": FRAME + "M6.5 3v10",
    "region-bottom": FRAME + "M2.5 9.5h11",
    "region-chat": FRAME + "M9.5 3v10",
    "region-props": FRAME + "M2.5 6h11M10 6v7",

    "more": circ(3.5, 8, 0.75) + circ(8, 8, 0.75) + circ(12.5, 8, 0.75),
    "chevron-down": "M4.5 6.2L8 9.8l3.5-3.6",
    "chevron-up": "M4.5 9.8L8 6.2l3.5 3.6",
    "chevron-right": "M6.2 4.5L9.8 8l-3.6 3.5",
    "chevron-left": "M9.8 4.5L6.2 8l3.6 3.5",
    "collapse-all": "M5 3l3 3 3-3M5 13l3-3 3 3",
    "search": circ(7, 7, 4) + "M10 10l3.5 3.5",
    "plus": "M8 3.5v9M3.5 8h9",
    "close": "M4.5 4.5l7 7M11.5 4.5l-7 7",
    "pin": "M6 2.5h4M7 2.5v3.3L4.5 9h7L9 5.8V2.5M8 9v4.5",
    "undo": "M5.5 3.5L3 6l2.5 2.5M3 6h6.5a3.5 3.5 0 0 1 0 7H6.5",
    "copy": "M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" + rr(5.5, 5.5, 8, 8),
    "check": "M3.5 8.3l3 3 6-6.3",
    "refresh": "M13 8a5 5 0 1 1-1.46-3.54M13 2.5V5h-2.5",
    "locate": circ(8, 8, 3) + "M8 2.5V5M8 11v2.5M2.5 8H5M11 8h2.5",
    "external": "M9.5 2.5h4v4M13.5 2.5L8 8M11.5 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h2.5",
    "send": "M8 13V3.5M4 7.5l4-4 4 4",
    "stop": rr(4.5, 4.5, 7, 7),

    "status-unsaved": circ(8, 8, 2.2),
    "status-running": "M13.5 8A5.5 5.5 0 1 1 8 2.5",
    "status-error": circ(8, 8, 5.5) + "M8 5v3.5M8 11h.01",
    "status-warn": "M7.1 3.1a1 1 0 0 1 1.8 0l4.9 8.9a1 1 0 0 1-.9 1.5H3.1a1 1 0 0 1-.9-1.5zM8 6.5v3M8 11.4h.01",
    "status-ok": circ(8, 8, 5.5) + "M5.5 8.2l1.8 1.8 3.2-3.5",
    "conn-on": PLUG,
    "conn-off": PLUG + "M2.5 2.5l11 11",

    "edit": "M10 3.2l2.8 2.8-7.3 7.3-3.3.5.5-3.3zM8.8 4.4l2.8 2.8",
    "pick": "M3.5 2.5l9 4-4 1.5-1.5 4z",
    "comment": "M4.5 13.5V11H4A1.5 1.5 0 0 1 2.5 9.5V4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7.5z",
    "chat-history": "M5.5 2.5H12A1.5 1.5 0 0 1 13.5 4v4.5M3.5 13.5v-2H4A1.5 1.5 0 0 1 2.5 10V6.5A1.5 1.5 0 0 1 4 5h6A1.5 1.5 0 0 1 11.5 6.5V10A1.5 1.5 0 0 1 10 11.5H6z",
    "present": "M5.5 3.5v9l7-4.5z",
    "draft-theme": circ(8, 8, 5.5) + "M8 2.5v11M8 5.2h3.6M8 8h5M8 10.8h3.6",
    "zoom": circ(7, 7, 4) + "M10 10l3.5 3.5M5.3 7h3.4M7 5.3v3.4",
    "source": "M5.5 4.5L2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5",
    "split": FRAME + "M8 3v10",
    "sel-region": "M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3",
    "sel-range": "M2.5 3.5v9M5 4h8.5M5 8h8.5M5 12h5",
    "sel-files": "M4 11.5V4A1.5 1.5 0 0 1 5.5 2.5H11" + rr(6, 5, 7.5, 8.5),

    "panel-props": "M2.5 5h11M2.5 11h11M5.5 3.5v3M10.5 9.5v3",
    "panel-changes": rr(2.5, 3, 4.5, 10, 1) + rr(9, 3, 4.5, 10, 1) + "M4 6.5h1.5M10.5 9.5h1.5",
    "panel-info": circ(8, 8, 5.5) + "M8 7.3v3.7M8 5h.01",
    "panel-outline": "M3 4.5h10M5.5 8h7.5M8 11.5h5",
    "app": rr(2, 2, 12, 12, 3) + "M5 5.5h6M5 8h6M5 10.5h3.5",

    "plugin": "M3 6.5A1.5 1.5 0 0 1 4.5 5H6a2 2 0 1 1 4 0h1.5A1.5 1.5 0 0 1 13 6.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12z",
    "sandbox": "M8 2.5l5 1.8v3.6c0 2.9-2.1 4.9-5 5.6-2.9-.7-5-2.7-5-5.6V4.3zM5.9 8.1l1.5 1.5 2.7-2.9",
    "deny": circ(8, 8, 5.5) + "M4.1 4.1l7.8 7.8",
    "coin": circ(8, 8, 5.5) + circ(8, 8, 2.8),
    "download": "M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13.5h10"
  };

  const GROUPS = [
    { label: "文件类型", note: "文件一律是页形，靠右下角那一块区分；图片是画框，目录是夹，组件稿沿用六边形（UI-2）", items: [
      ["file-dc", "设计稿 .dc.html"], ["file-comp", "组件稿"], ["file-md", "Markdown"], ["file-image", "图片"], ["file-json", "JSON"],
      ["file-code", "代码"], ["file-web", "网页 .html"], ["file", "其他"], ["folder", "目录 · 收"], ["folder-open", "目录 · 展"]] },
    { label: "区域", note: "画的是那一块在框里的哪条边。前三颗在顶栏，第四颗在 Tab 条右端", items: [
      ["region-tree", "目录栏"], ["region-bottom", "调试栏"], ["region-chat", "聊天栏"], ["region-props", "属性区"]] },
    { label: "通用动作", items: [
      ["more", "更多"], ["chevron-down", "展开"], ["chevron-up", "收起"], ["chevron-right", "树 · 收着"], ["chevron-left", "返回"],
      ["collapse-all", "全部折叠"], ["search", "搜索 / 转到"], ["plus", "新建"], ["close", "关闭"], ["pin", "固定"], ["undo", "撤销"],
      ["copy", "复制"], ["check", "已选"], ["refresh", "重建索引"], ["locate", "在目录中显示"], ["external", "在浏览器中打开"],
      ["send", "发送"], ["stop", "停止"]] },
    { label: "状态", note: "页签和树里的状态点仍用 6 px 实心圆点（CSS），这几颗给按钮、菜单和底栏用", items: [
      ["status-unsaved", "未保存"], ["status-running", "运行中（转）"], ["status-error", "错误"], ["status-warn", "提醒"],
      ["status-ok", "通过"], ["conn-on", "连接正常"], ["conn-off", "断开"]] },
    { label: "详情工具", items: [
      ["edit", "编辑（展开编辑栏）"], ["pick", "点选"], ["comment", "评论"], ["present", "演示"], ["draft-theme", "稿的浅深色"],
      ["zoom", "缩放"], ["source", "源码"], ["split", "分栏"], ["sel-region", "圈选"]] },
    { label: "面板 · 聊天 · 其他", items: [
      ["panel-props", "属性"], ["panel-changes", "变更"], ["panel-info", "信息"], ["panel-outline", "大纲"],
      ["chat-history", "会话历史"], ["sel-range", "带进 · 片段"], ["sel-files", "带进 · 文件"], ["app", "Umbra Studio"]] },
    { label: "插件 · 第十轮", note: "「不允许」用 deny，不用 close：close 是关掉一个东西，deny 是这件事做不了", items: [
      ["plugin", "插件"], ["sandbox", "沙箱 · 权限"], ["deny", "不允许"], ["coin", "积分"], ["download", "安装 / 下载"]] }
  ];

  window.UMBRA_ICONS = ICONS;
  window.UMBRA_ICON_GROUPS = GROUPS;
  try { window.dispatchEvent(new Event("umbra-icons")); } catch (e) {}
})();
