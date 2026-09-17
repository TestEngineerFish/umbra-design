/* UmbraDesign · 预览点选桥。doc/00 §十九
 *
 * 跑在**被预览的那份稿**里，由预览壳（S2）在 iframe 载入之后注入 ——
 * 不进稿本身。稿是设计事实，点选是工具行为，两者不能混在一个文件里。
 * 壳和稿由同一个本地静态服务发出，同源，所以壳能往 iframe 里塞这段脚本。
 *
 * 地址怎么来（doc/00 §17.3 实测）：
 *   file = 最近的 [data-sc-name] 的值   —— 运行时自己打的组件边界
 *   node = [data-ud-node] 的值          —— 我们落盘时打的节点地址
 * 两个属性都已经在 DOM 里，所以这一步不问服务端。
 *
 * ⚠️ 点选模式必须能关。预览既要「点一下选中它」，也要「点一下真的用这个界面」——
 * 只给前者的话，带交互的稿在预览里就试不动了。开关是 <html data-ud-select-on>，
 * 对应运行时自己那套 <body data-dc-editor-on>（§17.1）的思路。
 */
(function () {
  if (window.__udSelectBridge) return;              // 壳可能重复注入
  window.__udSelectBridge = true;

  var ROOT = document.documentElement;
  var HL = null, CUR = null;

  function on() { return ROOT.hasAttribute("data-ud-select-on"); }

  function overlay() {
    if (HL) return HL;
    HL = document.createElement("div");
    HL.setAttribute("data-ud-overlay", "");
    HL.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" +
      "border:1.5px solid #3a49cf;background:rgba(58,73,207,.10);border-radius:2px;" +
      "transition:all .06s ease;display:none";
    document.body.appendChild(HL);
    return HL;
  }

  function show(el) {
    var o = overlay(), r = el.getBoundingClientRect();
    o.style.display = "block";
    o.style.left = r.left + "px"; o.style.top = r.top + "px";
    o.style.width = r.width + "px"; o.style.height = r.height + "px";
  }
  function hide() { if (HL) HL.style.display = "none"; }

  /** 从任意 DOM 节点找到最近的可寻址节点，并算出它的地址 */
  function addressOf(el) {
    var node = el && el.closest ? el.closest("[data-ud-node]") : null;
    if (!node) return null;
    var host = node.closest("[data-sc-name]");
    var file = host ? host.getAttribute("data-sc-name") : null;
    if (!file && typeof window.__dcRootName === "function") {
      try { file = window.__dcRootName(); } catch (e) { /* 没有就算了 */ }
    }
    var r = node.getBoundingClientRect();
    return {
      file: file, node: node.getAttribute("data-ud-node"),
      tag: node.tagName.toLowerCase(),
      // 同一个地址在 sc-for 里对应多个 DOM 节点 —— 告诉壳这是第几个，
      // 让它能说清「改这一处会影响这 N 行」
      instances: document.querySelectorAll(
        '[data-ud-node="' + node.getAttribute("data-ud-node") + '"]').length,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      text: (node.textContent || "").trim().slice(0, 60)
    };
  }

  /* ── 样式覆盖通道（doc/00 §二十五）──
   *
   * 拖滑块的中间态不落盘：往稿里注一张 <style>，按节点地址写
   * `[data-ud-node="…"] { prop: value !important }`，松手才真写文件。
   *
   * ⚠️ 只做 **style**，不做属性和文本。原因是所有权：
   * 样式表是 React 不管的东西，写进去不会被下一次渲染冲掉；
   * 而属性与文本由 React 托管，直接改会在重渲染时被还原 —— 那种"预览"会闪回，
   * 比没有预览更糟。
   *
   * ⚠️ 用 !important：稿里的值是写在 style 属性上的（doc/06 §2.1），
   * 内联样式优先级更高，不加 !important 盖不住。
   *
   * sc-for 里一个地址对应多个 DOM 节点，选择器天然全命中 ——
   * 这与"改一处影响每一行"的落盘语义一致，不用特殊处理。
   */
  var SHEET_ID = "ud-preview-override";
  var overrides = {};        // "nodeId" -> { prop: value }

  function sheet() {
    var el = document.getElementById(SHEET_ID);
    if (el) return el;
    el = document.createElement("style");
    el.id = SHEET_ID;
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  function cssEscape(v) { return String(v).replace(/["\\]/g, "\\$&"); }

  function flush() {
    var out = [], ids = Object.keys(overrides);
    for (var i = 0; i < ids.length; i++) {
      var props = overrides[ids[i]], keys = Object.keys(props), decls = [];
      for (var j = 0; j < keys.length; j++) {
        if (props[keys[j]] === "") continue;
        decls.push(keys[j] + ":" + props[keys[j]] + " !important");
      }
      if (decls.length) out.push('[data-ud-node="' + cssEscape(ids[i]) + '"]{' + decls.join(";") + "}");
    }
    sheet().textContent = out.join("\n");
    return out.length;
  }

  function previewStyle(nodeId, prop, value) {
    if (!nodeId || !prop) return;
    if (!overrides[nodeId]) overrides[nodeId] = {};
    overrides[nodeId][prop] = value == null ? "" : String(value);
    var n = flush();
    send("preview", { node: nodeId, prop: prop, value: value, rules: n });
  }

  function clearPreview(nodeId) {
    if (nodeId) delete overrides[nodeId]; else overrides = {};
    send("preview", { node: nodeId || null, cleared: true, rules: flush() });
  }

  function send(type, payload) {
    try { window.parent.postMessage({ source: "umbradesign", type: type, payload: payload }, "*"); }
    catch (e) { /* 没有父窗口就当没这回事 */ }
  }

  document.addEventListener("mousemove", function (e) {
    if (!on()) { hide(); return; }
    var node = e.target && e.target.closest ? e.target.closest("[data-ud-node]") : null;
    if (node) show(node); else hide();
  }, true);

  /* ⚠️ 这里**不能**用捕获阶段。mouseleave 不冒泡，但捕获阶段是 document → target，
     所以挂在 document 上的捕获监听会收到**任意**子元素的 mouseleave ——
     鼠标在稿里一动，高亮框就被藏掉。实测踩到：点完一个节点高亮框是 display:none。
     不加 true，document 上的 mouseleave 只在真的离开文档时才触发。 */
  document.addEventListener("mouseleave", hide);

  // 捕获阶段拦下来，**只在点选模式下**阻止稿自己的处理器 ——
  // 关掉开关之后稿的交互一切照旧
  document.addEventListener("click", function (e) {
    if (!on()) return;
    var a = addressOf(e.target);
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    CUR = a;
    send("select", a);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { CUR = null; hide(); send("clear", null); }
  }, true);

  // 壳可以问「现在选的是谁」，也可以让 iframe 高亮某个地址
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.source !== "umbradesign-shell") return;
    if (m.type === "set-mode") {
      if (m.payload) ROOT.setAttribute("data-ud-select-on", ""); else { ROOT.removeAttribute("data-ud-select-on"); hide(); }
      send("mode", on());
      return;
    }
    if (m.type === "highlight") {
      var el = m.payload && document.querySelector('[data-ud-node="' + m.payload + '"]');
      if (el) { show(el); el.scrollIntoView({ block: "center", behavior: "smooth" }); } else hide();
      return;
    }
    if (m.type === "preview-style") {
      var q = m.payload || {};
      previewStyle(q.node, q.prop, q.value);
      return;
    }
    if (m.type === "clear-style") { clearPreview((m.payload || {}).node); return; }
    if (m.type === "ping") send("ready", {
      nodes: document.querySelectorAll("[data-ud-node]").length,
      mode: on(),
      previewRules: Object.keys(overrides).length
    });
  });

  send("ready", { nodes: document.querySelectorAll("[data-ud-node]").length, mode: on() });
})();
