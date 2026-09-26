import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { TOOL_ROOT } from "../project.js";
import { checkManifest, type PluginManifest } from "./manifest.js";

/** 插件包的格式与验签（M11-6）。
 *
 *  **`.umbraplugin` = gzip 过的一个 JSON 容器**，零依赖、跨平台。
 *
 *  为什么不是 zip：`outgoing.ts` 那样 shell 调 `zip` 是开发脚本的做法，
 *  **打包后的应用不能指望用户机器上装了什么**（Windows 尤其没有 unzip）。
 *  `node:zlib` 是内置的，两个平台行为一致。
 *  这和 §85.2 里「`execPath` 不能写死 `node`」是同一条规矩。
 *
 *  代价：二进制走 base64，比 zip 大三分之一。对现在的插件（markdown-it 135 KB）无所谓，
 *  **对将来的视频插件不行** —— 所以容器里带 `format` 版本号，换流式格式时能并存。
 */
export interface PluginPackage {
  format: 1;
  /** 清单的副本，装之前不解全包就能看权限。**真正生效的是 `files["manifest.json"]`** */
  manifest: PluginManifest;
  /** 路径 → base64。路径是插件目录内的相对路径，`/` 分隔 */
  files: Record<string, string>;
  /** 对 `canonical()` 的 Ed25519 签名（base64）。开发包可以没有 */
  signature?: string;
}

/** 确定性序列化：**签的是这个**。
 *  键排序 + 不留空格 —— 同一份内容在任何机器上都得到同一串字节，
 *  否则签名在另一台机器上验不过，而症状是「这个包坏了」。 */
export function canonical(pkg: Pick<PluginPackage, "format" | "manifest" | "files">): Buffer {
  const files: Record<string, string> = {};
  for (const k of Object.keys(pkg.files).sort()) files[k] = pkg.files[k]!;
  return Buffer.from(JSON.stringify({ format: pkg.format, manifest: pkg.manifest, files }), "utf8");
}

/** 把一个插件目录打成包。发布侧用（`npm --prefix server run packplugin`） */
export async function packDir(dir: string): Promise<PluginPackage> {
  const files: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;          // .DS_Store 之类不进包
      const abs = join(d, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      files[relative(dir, abs).split(sep).join("/")] = (await readFile(abs)).toString("base64");
    }
  };
  await walk(dir);
  const raw = files["manifest.json"];
  if (!raw) throw new Error("插件目录里没有 manifest.json");
  const m = checkManifest(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  if (!m.ok) throw new Error("清单不合法：" + m.problems.map((x) => `${x.field} ${x.why}`).join("；"));
  return { format: 1, manifest: m.manifest!, files };
}

export const encodePackage = (pkg: PluginPackage): Buffer => gzipSync(Buffer.from(JSON.stringify(pkg), "utf8"));

export function decodePackage(buf: Buffer): PluginPackage {
  let json: string;
  try { json = gunzipSync(buf).toString("utf8"); }
  catch { throw new Error("这不是一个 .umbraplugin 包（gzip 解不开）"); }
  const pkg = JSON.parse(json) as PluginPackage;
  if (pkg.format !== 1) throw new Error(`包格式版本 ${pkg.format} 认不了，这一版只认 1`);
  if (!pkg.files || typeof pkg.files !== "object") throw new Error("包里没有 files");
  return pkg;
}

/** 发布方公钥。**不在仓库里** —— 发布时随产物一起放进 `TOOL_ROOT/keys/`。 */
const PUBKEY = join(TOOL_ROOT, "keys", "publisher.pub");

export interface VerifyResult { ok: boolean; why?: string; dev?: boolean }

/** 验签。**这是信任边界上的第二道关**（第一道是清单校验）。
 *
 *  ⚠️ 没有公钥时**拒装**，不是放行 —— 默认拒绝，例外要显式打开。
 *  开发期用 `UMBRASTUDIO_PLUGIN_DEV=1` 放行未签名包，**并标成 `dev: true`**，
 *  界面上要显示「未签名」。不标的话，开发期装的和正式装的看起来一样，
 *  而那正是「怎么会装上一个没签名的插件」这类事故的起点。
 */
export function verifyPackage(pkg: PluginPackage): VerifyResult {
  const dev = process.env.UMBRASTUDIO_PLUGIN_DEV === "1";
  if (!existsSync(PUBKEY)) {
    return dev
      ? { ok: true, dev: true, why: "本机没有发布方公钥，按开发模式放行 —— 这个插件是未签名的" }
      : { ok: false, why: "本机没有发布方公钥（keys/publisher.pub），装不了插件。这通常说明安装包不完整" };
  }
  if (!pkg.signature) {
    return dev
      ? { ok: true, dev: true, why: "包里没有签名，按开发模式放行 —— 这个插件是未签名的" }
      : { ok: false, why: "这个包没有签名，拒绝安装" };
  }
  try {
    const key = createPublicKey(readFileSync(PUBKEY));
    /* Ed25519 用 `crypto.verify(null, …)` —— 它不走摘要算法那一套，
       传 "sha256" 之类会直接抛。这一点和 RSA/ECDSA 不同，容易写错。 */
    const ok = edVerify(null, canonical(pkg), key, Buffer.from(pkg.signature, "base64"));
    return ok ? { ok: true } : { ok: false, why: "签名验不过 —— 包被改过，或者不是我们签的" };
  } catch (e) {
    return { ok: false, why: `验签出错：${(e as Error).message}` };
  }
}
