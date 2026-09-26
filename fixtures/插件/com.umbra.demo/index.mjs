/* 演示插件（M11-4 的验证件）。**插件里一个 import 都没有** —— 这是 Q37 定的契约形状：
   插件是独立更新的，和主程序必然版本错配，所以全部能力从 host 这一个带版本号的对象拿。

   它同时是**沙箱的攻击样本**：下面 probe 那件能力故意去做插件不该做的事，
   plugintest 拿它来验「关不关得住」。沙箱不被攻一次，等于没验。 */
export default function register(host) {
  host.defineCap({
    name: "com.umbra.demo.rows",
    title: "数一数 CSV 有几行",
    summary: "读一个 csv 文件，返回行数和第一行的列名。用来验证插件能通过宿主读文件。",
    input: { path: "string" },
    async run({ path }) {
      const out = await host.call("read_file", { path });
      if (!out.ok) return { ok: false, why: out.errors?.[0]?.message ?? "读不到" };
      const lines = String(out.data.content ?? "").split("\n").filter((l) => l.trim());
      return { ok: true, rows: lines.length, header: (lines[0] ?? "").split(",") };
    },
  });

  /* ── 攻击样本：这四件插件都不该做成 ── */
  host.defineCap({
    name: "com.umbra.demo.probe",
    title: "（测试用）试着越界",
    summary: "故意去做插件不该做的事，给 plugintest 验沙箱用。正常插件不会有这种能力。",
    input: {},
    async run() {
      const r = {};
      /* ① 直接碰文件系统 —— 权限模型该拦住 */
      try { const fs = await import("node:fs"); fs.readFileSync("/etc/hosts"); r.readEtc = "读到了"; }
      catch (e) { r.readEtc = "被拦 " + (e.code ?? e.message?.slice(0, 30)); }
      /* ② 写盘 */
      try { const fs = await import("node:fs"); fs.writeFileSync("/tmp/ud-pwned", "x"); r.write = "写进去了"; }
      catch (e) { r.write = "被拦 " + (e.code ?? e.message?.slice(0, 30)); }
      /* ③ 起子进程（P1 的落点） */
      try { const cp = await import("node:child_process"); cp.execSync("echo pwned"); r.exec = "起来了"; }
      catch (e) { r.exec = "被拦 " + (e.code ?? e.message?.slice(0, 30)); }
      /* ④ 调一件白名单外的宿主能力 */
      const out = await host.call("write_draft", { path: "x.dc.html", content: "<x-dc></x-dc>" });
      r.offWhitelist = out.ok ? "**调到了**" : "被拦 " + (out.errors?.[0]?.message ?? "").slice(0, 26);
      return r;
    },
  });
}
