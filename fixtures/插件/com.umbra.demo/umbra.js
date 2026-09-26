/** 插件侧的桥（M11-5）。**插件把这一份拷进自己的包里**，不是从我们这儿 import ——
 *  插件关在不透明源的 iframe 里，CSP `connect-src 'none'`，它取不到我们的任何文件。
 *
 *  这也正是 Q37 想要的：插件和主程序之间只有**一条 postMessage 通道**和这份约定，
 *  没有模块依赖。主程序更了五版，这份还是这份。
 *
 *  用法：
 *    umbra.onContext(ctx => { /* ctx.path 当前文件 · ctx.theme 主题 *\/ });
 *    const out = await umbra.call("read_file", { path: ctx.path });
 *    const picked = await umbra.menu(x, y, [{ label: "改名" }, { label: "—" }, { label: "删除", danger: true }]);
 *    umbra.toast("存好了");
 */
(function (global) {
  var seq = 0, pending = {}, ctxCbs = [], lastCtx = null;

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "reply") {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      p(m.payload);
      return;
    }
    if (m.t === "ctx") {
      lastCtx = m;
      for (var i = 0; i < ctxCbs.length; i++) ctxCbs[i](m);
    }
  });

  function send(msg) {
    var id = ++seq;
    msg.id = id;
    return new Promise(function (res) { pending[id] = res; parent.postMessage(msg, "*"); });
  }

  global.umbra = {
    /** 宿主 API 的大版本。对不上就别接 —— 插件是独立更新的，版本错配是常态 */
    version: 1,
    /** 调一件宿主能力（read_file / write_file …）。
     *  ⚠️ 返回的是**信封** `{ok, data, errors}`，不是直接的数据 ——
     *  权限不够、文件被人改过都走 `ok:false`，别只看 `data`。 */
    call: function (cap, input) { return send({ t: "call", cap: cap, input: input || {} }); },
    /** 弹一个菜单。**由宿主画** —— 插件自己画会被矩形裁掉，形制也和主程序对不上。
     *  返回被点的那一项的下标；点空关掉就一直不返回。`{label:"—"}` 是分隔线。 */
    menu: function (x, y, items) { return send({ t: "menu", x: x, y: y, items: items }); },
    /** 提示条。也由宿主画 */
    toast: function (title, body, level) { parent.postMessage({ t: "toast", title: title, body: body, level: level }, "*"); },
    /** 当前上下文（哪个文件、什么主题）。**插件不能自己去问** —— 它没有网络。
     *  注册时如果已经收到过一次，会立刻用最后那次回调一下，免得错过首帧。 */
    onContext: function (cb) { ctxCbs.push(cb); if (lastCtx) cb(lastCtx); },
  };
  parent.postMessage({ t: "ready" }, "*");
})(window);
