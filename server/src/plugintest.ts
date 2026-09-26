/** 插件机制的回归（M11-4）。**重点不是"插件能跑"，是"关不关得住"。**
 *
 *  `fixtures/插件/com.umbra.demo` 里那个插件同时是**攻击样本**：
 *  它的 `probe` 能力故意去做插件不该做的四件事。
 *  沙箱不被攻一次，等于没验 —— 「没出事」和「关住了」在日志上长得一样。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifest, HOST_API_MAJOR } from "./plugin/manifest.js";
import { PluginSandbox } from "./plugin/sandbox.js";
import { allowedCapNames } from "./plugin/host.js";
import { buildProject } from "./project.js";
import { BUILTIN, kindOf, registerKind, unregisterKindsFrom } from "./shared/kinds.js";

let pass = 0, fail = 0;
const ok = (c: boolean, what: string, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${what}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${what}${detail ? " — " + detail : ""}`); }
};

const DIR = join(process.cwd(), "..", "fixtures", "插件", "com.umbra.demo");

console.log("插件机制（M11-4）");

/* ── ① 清单校验：信任边界上的第一道关 ── */
const raw = JSON.parse(await readFile(join(DIR, "manifest.json"), "utf8"));
const good = checkManifest(raw);
ok(good.ok, "演示插件的清单合法", good.problems.map((p) => p.field).join(" "));

const bads: Array<[string, unknown, string]> = [
  ["id 里有路径分隔符", { ...raw, id: "../../etc" }, "id 兼做目录名，能逃出去就能写到别处"],
  ["入口路径带 ..", { ...raw, tools: "../../../server/dist/index.js" }, "能加载我们的文件"],
  ["hostApi 对不上", { ...raw, hostApi: "^99" }, `本机是 v${HOST_API_MAJOR}，插件独立更新，版本错配是常态`],
  ["没声明 permissions", (() => { const { permissions: _p, ...r } = raw; return r; })(), "默认不是「全给」，是「拒装」"],
  ["清单里写了 exec", { ...raw, permissions: { ...raw.permissions, exec: ["ffmpeg"] } }, "P1：连槽位都不留，写了当场拒"],
  ["扩展名不带点", { ...raw, kinds: [{ ...raw.kinds[0], ext: ["csv"] }] }, "不带点会把 abc.mycsv 也认成 csv"],
];
for (const [what, m, why] of bads) {
  const r = checkManifest(m);
  ok(!r.ok, `清单拒绝：${what}`, why);
}

/* ── ② 类型注册：插件加的格式立刻生效，卸载就退回去 ── */
const k = good.manifest!.kinds![0]!;
registerKind({ id: k.id, label: k.label, icon: k.icon, priority: k.priority!, textual: k.textual,
  match: (n) => k.ext.some((e) => n.endsWith(e)), from: good.manifest!.id });
ok(kindOf("data/表.csv") === "csv", "插件加的类型立刻生效");
ok(kindOf("x.dc.html") === BUILTIN.dc, "没动到内置类型");

/* ── ③ 沙箱：先证明它活着，再看它关不关得住 ── */
const sb = new PluginSandbox(good.manifest!, DIR);
let started = true;
try { await sb.start(); } catch (e) { started = false; ok(false, "沙箱起得来", (e as Error).message); }

if (started) {
  ok(sb.caps.length === 2, "插件声明的能力报上来了", `${sb.caps.map((c) => c.name).join(" / ")}`);
  ok(sb.caps.every((c) => c.name.startsWith("com.umbra.demo.")), "能力名带插件 id 前缀（防两个插件撞名）");

  /* **先做正向**：不先证明这条路是通的，后面「被拦住」就分不清是关住了还是本来就没通
     —— 纪律④ 要的对照组。
     ⚠️ 项目用临时目录，**不碰 `projects/`** —— 那是用户自己的东西（纪律⑥）。 */
  const TMP = join(tmpdir(), `umbrastudio-plugintest-${Date.now()}`);
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "project.json"), JSON.stringify({ name: "plugintest", title: "插件回归" }));
  await writeFile(join(TMP, "表.csv"), "name,role\n甲,设计\n乙,开发\n");
  const p = await buildProject(TMP);

  let normal: Record<string, unknown> = {};
  try { normal = await sb.invoke("com.umbra.demo.rows", { path: "表.csv" }, p) as Record<string, unknown>; }
  catch (e) { normal = { ok: false, why: (e as Error).message }; }
  ok(normal.ok === true && normal.rows === 3,
    "**对照组**：插件经 host.call 真读到了文件（这条不通，下面的「被拦」就不算数）",
    JSON.stringify(normal).slice(0, 70));

  /* 攻击样本 */
  const r = await sb.invoke("com.umbra.demo.probe", {}, p) as Record<string, string>;
  ok(!!r.readEtc?.startsWith("被拦"), "① 插件读不了 /etc/hosts（Node 权限模型）", r.readEtc);
  ok(!!r.write?.startsWith("被拦"), "② 插件一个字节都写不了盘（没给 --allow-fs-write）", r.write);
  ok(!!r.exec?.startsWith("被拦"), "③ **插件起不了子进程**（P1 的落点）", r.exec);
  ok(!!r.offWhitelist?.startsWith("被拦"), "④ 白名单外的宿主能力调不到（write_draft 不在白名单里）", r.offWhitelist);
  sb.stop();
}

/* ── ④ 白名单是白名单，不是黑名单 ── */
const names = allowedCapNames();
ok(!names.includes("write_draft") && !names.includes("chat_send"),
  "白名单里没有设计稿写入口和会话 —— 没列的一律调不到，包括将来新加的能力");

ok(unregisterKindsFrom("com.umbra.demo") === 1, "卸载把类型摘干净");
ok(kindOf("data/表.csv") === BUILTIN.other, "卸载后退回 other（文件卡），不是打不开");
await rm(join(tmpdir(), "x"), { recursive: true, force: true }).catch(() => {});

/* ── ⑤ A 面的 CSP：**真起一次 http 打穿看看** ──
   这是整套机制唯一的安全断言，不实测不算数。
   ⚠️ 判据看的是**响应头**不是页面里的 meta —— 头是插件碰不到的那一层。 */
{
  const { PLUGINS_DIR } = await import("./plugin/store.js");
  await mkdir(join(PLUGINS_DIR, "com.umbra.demo", "0.1.0"), { recursive: true });
  await writeFile(join(PLUGINS_DIR, "com.umbra.demo", "0.1.0", "manifest.json"), await readFile(join(DIR, "manifest.json"), "utf8"));
  await writeFile(join(PLUGINS_DIR, "com.umbra.demo", "0.1.0", "index.html"), "<b>plugin ui</b>");
  const { pluginDirOf } = await import("./plugin/store.js");
  ok(pluginDirOf("com.umbra.demo") !== null, "装进 STATE_ROOT 之后找得到它的目录");
  /* 目录逃逸：id 里带路径分隔符，或者文件路径带 .. */
  ok(pluginDirOf("../../etc") === null, "id 逃不出插件目录");
  const { listInstalled } = await import("./plugin/store.js");
  const installed = await listInstalled();
  ok(installed.some((x) => x.manifest.id === "com.umbra.demo" && x.problems.length === 0), "列得出来且清单没毛病");
  /* ⚠️ **不删，装回去**（M11-9b 改）：`uitest` 的插件端到端那一组要靠它。
     原来这里删掉，结果 `plugintest` 跑完再跑 `uitest`，那一组（9 条）**整块消失**，
     而总数照样打勾 —— 「119/119 全过」和「127/127 全过」在输出里都是一个 ✓。
     判据整块消失不会报警，它和「这些判据通过了」长得一模一样。
     演示插件是开发期夹具，`.umbrastudio/` 不进仓库，留着没有代价。 */
  const { cp } = await import("node:fs/promises");
  await cp(DIR, join(PLUGINS_DIR, "com.umbra.demo", "0.1.0"), { recursive: true });
  ok(true, "演示插件已装好（uitest 的插件端到端那一组要用它）");
}

/* ══════════ 装 / 验签 / 切版本（M11-6）══════════
   **重点仍然是「拦不拦得住」** —— 装插件是信任边界上最危险的一步：
   它把别人给的字节写进用户的机器。所以这里和 §85.5 一样，用攻击样本来验。 */
{
  const { generateKeyPairSync, sign: edSign } = await import("node:crypto");
  const { canonical, encodePackage, decodePackage, packDir, verifyPackage } = await import("./plugin/pack.js");
  const { installPackage, pluginVersions, switchVersion } = await import("./plugin/install.js");
  const { PLUGINS_DIR } = await import("./plugin/store.js");
  const { writeFile: wf, mkdir: md, rm: rmp } = await import("node:fs/promises");

  const KEYS = join(process.cwd(), "..", "keys");
  const pub = join(KEYS, "publisher.pub");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await md(KEYS, { recursive: true });
  await wf(pub, publicKey.export({ type: "spki", format: "pem" }));

  const pkg = await packDir(DIR);
  ok(Object.keys(pkg.files).length >= 4, "打包读到了插件的文件", `${Object.keys(pkg.files).length} 个`);

  /* ① 没签名 → 拒装（本机有公钥，不是开发模式） */
  delete process.env.UMBRASTUDIO_PLUGIN_DEV;
  ok(verifyPackage(pkg).ok === false, "**没签名的包拒装**（默认拒绝，例外要显式打开）");

  /* ② 签了 → 过 */
  pkg.signature = edSign(null, canonical(pkg), privateKey).toString("base64");
  ok(verifyPackage(pkg).ok === true, "签过的包验得过");

  /* ③ **篡改一个字节就得验不过** —— 这是签名唯一要保证的事，
     不验这一条的话「签名机制」可能只是把一串 base64 存了又读回来。 */
  const tampered = { ...pkg, files: { ...pkg.files, "manifest.json": Buffer.from(
    Buffer.from(pkg.files["manifest.json"]!, "base64").toString("utf8").replace('"read"', '"write"'), "utf8").toString("base64") } };
  ok(verifyPackage(tampered as typeof pkg).ok === false, "**包被改过一个字节就验不过**（把权限从 read 偷改成 write）");

  /* ④ 路径逃逸：包里塞一个跑到插件目录外面的路径 */
  const evil = { ...pkg, files: { ...pkg.files, "../../../../pwned.txt": Buffer.from("x").toString("base64") } };
  evil.signature = edSign(null, canonical(evil), privateKey).toString("base64");   // 连签名都是真的
  let threw = "";
  try { await installPackage(evil as typeof pkg); } catch (e) { threw = (e as Error).message; }
  ok(threw.includes("逃出插件目录"), "**包里逃出目录的路径被拦**（签名真也不行 —— 签名只证明是谁给的，不证明它安全）", threw.slice(0, 40));

  /* ⑤ 真装一次 */
  await rmp(join(PLUGINS_DIR, "com.umbra.demo"), { recursive: true, force: true });
  const r1 = await installPackage(pkg);
  ok(r1.id === "com.umbra.demo" && r1.previous === null, "首次安装", `${r1.id} ${r1.version}`);
  ok(r1.unsigned === false, "签过的包不标未签名");
  ok(r1.kinds.includes("csv"), "**装完类型立刻注册上了，不用重启**（M11-10）", r1.kinds.join("/"));

  /* ⑥ 装第二版 → 切回第一版 */
  const v2 = JSON.parse(JSON.stringify(pkg)) as typeof pkg;
  v2.manifest.version = "0.2.0";
  v2.files["manifest.json"] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pkg.files["manifest.json"]!, "base64").toString("utf8")), version: "0.2.0" }), "utf8").toString("base64");
  v2.signature = edSign(null, canonical(v2), privateKey).toString("base64");
  const r2 = await installPackage(v2);
  ok(r2.previous === "0.1.0", "更新时认得出上一版", `previous=${r2.previous}`);
  let vs = await pluginVersions("com.umbra.demo");
  ok(vs.current === "0.2.0" && vs.versions.length === 2, "两版都在，指针指向新版", `${vs.versions.join("/")} → ${vs.current}`);
  await switchVersion("com.umbra.demo", "0.1.0");
  vs = await pluginVersions("com.umbra.demo");
  ok(vs.current === "0.1.0", "**切回上一版只改指针**（回退很便宜）", `→ ${vs.current}`);

  /* 收尾：公钥是这一节临时造的，删掉；插件留着给 uitest 用 */
  await rmp(KEYS, { recursive: true, force: true });
  await rmp(join(PLUGINS_DIR, "com.umbra.demo", "0.2.0"), { recursive: true, force: true });
  await wf(join(PLUGINS_DIR, "com.umbra.demo", "current"), "0.1.0", "utf8");
  void decodePackage; void encodePackage;
}

console.log(fail === 0 ? `\n✓ 插件机制 ${pass}/${pass + fail}` : `\n✗ 插件机制 ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
