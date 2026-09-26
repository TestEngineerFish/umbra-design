import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { decodePackage, verifyPackage, type PluginPackage } from "./pack.js";
import { checkManifest } from "./manifest.js";
import { BUNDLED_DIR, PLUGINS_DIR, registerPluginKinds } from "./store.js";

/** 装 / 更新 / 切版本 / 卸（M11-6）。
 *
 *  目录形状 `STATE_ROOT/.umbrastudio/plugins/<id>/<version>/`：
 *  **版本各占一个目录，切换是改指针** —— 回退只要把指针改回去（`doc/20` §6.3）。
 *  指针存在 `<id>/current`，里面就一行版本号。
 */

/** 只保留最近两版。**再老的删掉** —— 不然装几次就占满盘（`doc/20` §6.3） */
const KEEP = 2;

export interface InstallResult {
  id: string; version: string;
  /** 之前装的是哪一版（这次是更新的话）。null = 首次安装 */
  previous: string | null;
  /** 未签名（开发模式放行的）。**界面上要显示出来** */
  unsigned: boolean;
  note?: string;
  /** 它认领了哪些文件类型 —— 装完要立刻生效，不能等重启（M11-10） */
  kinds: string[];
}

/** 从一个 `.umbraplugin` 文件装。
 *
 *  ⚠️ **顺序不能换**：解包 → 验签 → 校验清单 → 逐个路径查逃逸 → 落盘。
 *  任何一步失败都**不落一个字节** —— 半装的插件比没装还糟：
 *  类型表认得这种文件，模块却不全，界面会落到文件卡上，看着像「插件没装」。
 */
export async function installFromFile(file: string): Promise<InstallResult> {
  const pkg = decodePackage(await readFile(file));
  return installPackage(pkg);
}

export async function installPackage(pkg: PluginPackage): Promise<InstallResult> {
  const v = verifyPackage(pkg);
  if (!v.ok) throw new Error(v.why ?? "验签没过");

  /* 包里的 manifest 副本只是给「装之前看权限」用的，**真正生效的是 files 里那一份** ——
     两份不一致时以 files 为准，否则伪造副本就能让用户看到一份假的权限清单。 */
  const raw = pkg.files["manifest.json"];
  if (!raw) throw new Error("包里没有 manifest.json");
  const m = checkManifest(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  if (!m.ok) throw new Error("清单不合法：" + m.problems.map((x) => `${x.field} ${x.why}`).join("；"));
  const man = m.manifest!;

  if (existsSync(join(BUNDLED_DIR, man.id))) {
    throw new Error(`${man.id} 是内置插件，不能用装包的方式覆盖它`);
  }

  const idDir = join(PLUGINS_DIR, man.id);
  const target = join(idDir, man.version);
  /* 同一版重装 = 先清掉再写，不做增量 —— 增量会让「删掉的文件还在」 */
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const [rel, b64] of Object.entries(pkg.files)) {
    /* ⚠️ **路径逃逸**：包里的路径是攻击者可控的。`a/../../../../etc/x` 这种
       `join` 出来会落到插件目录外面。判据是「拼完还在不在 target 里」，
       不是「字符串里有没有 ..」—— 后者漏掉编码变体。 */
    const abs = join(target, normalize(rel));
    if (!abs.startsWith(target + "/") && abs !== target) {
      await rm(target, { recursive: true, force: true });
      throw new Error(`包里有逃出插件目录的路径：${rel}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(b64, "base64"));
  }
  /* 未签名的留个记号 —— 界面按它显示「未签名」。放文件里而不是只放内存，
     因为重启之后这件事仍然成立。 */
  if (v.dev) await writeFile(join(target, ".unsigned"), v.why ?? "开发模式安装");

  const versions = (await readdir(idDir)).filter((x) => x !== "current").sort();
  const previous = versions.filter((x) => x !== man.version).slice(-1)[0] ?? null;
  await writeFile(join(idDir, "current"), man.version, "utf8");

  /* 只留最近两版 */
  for (const old of versions.slice(0, Math.max(0, versions.length - KEEP))) {
    if (old !== man.version) await rm(join(idDir, old), { recursive: true, force: true });
  }

  /* ⚠️ **装完立刻在服务端注册它的类型**（M11-10）：
     不做这一步的话，新格式的文件在目录列里还是「其他」、改了也不触发刷新，
     用户得重启应用才生效 —— 而他刚点完「安装」，那一刻最不该让他重启。 */
  const registered = await registerPluginKinds();
  return {
    id: man.id, version: man.version, previous,
    unsigned: !!v.dev, note: v.why,
    kinds: registered.find((x) => x.id === man.id)?.kinds ?? [],
  };
}

/** 一个插件装了哪几版，当前用哪一版 */
export async function pluginVersions(id: string): Promise<{ versions: string[]; current: string | null }> {
  const idDir = join(PLUGINS_DIR, id);
  if (!existsSync(idDir)) return { versions: [], current: null };
  const versions = (await readdir(idDir)).filter((x) => x !== "current").sort();
  let current: string | null = null;
  try { current = (await readFile(join(idDir, "current"), "utf8")).trim() || null; } catch { /* 没指针 */ }
  return { versions, current: current && versions.includes(current) ? current : versions[versions.length - 1] ?? null };
}

/** 切到某一版（回退就是切回旧的那一版）。**只改指针，不动文件** */
export async function switchVersion(id: string, version: string): Promise<{ id: string; version: string; kinds: string[] }> {
  const { versions } = await pluginVersions(id);
  if (!versions.includes(version)) throw new Error(`${id} 没有装过 ${version}（装了：${versions.join(" / ") || "无"}）`);
  await writeFile(join(PLUGINS_DIR, id, "current"), version, "utf8");
  const registered = await registerPluginKinds();
  return { id, version, kinds: registered.find((x) => x.id === id)?.kinds ?? [] };
}
