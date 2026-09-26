/** 把一个插件目录打成 `.umbraplugin`，可选签名（M11-6，发布侧用）。
 *
 *     npm --prefix server run packplugin -- <插件目录> [输出文件] [私钥文件]
 *
 *  ⚠️ **私钥不进仓库**。它属于发布流程，放 CI 的密钥库或你自己的密码管理器。
 *  生成一对：
 *     node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');
 *       require('fs').writeFileSync('publisher.key',privateKey.export({type:'pkcs8',format:'pem'}));
 *       require('fs').writeFileSync('publisher.pub',publicKey.export({type:'spki',format:'pem'}))"
 *  公钥随产物发（`TOOL_ROOT/keys/publisher.pub`），私钥**只在签名那一刻出现**。
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { canonical, encodePackage, packDir } from "./plugin/pack.js";

const [dirArg, outArg, keyArg] = process.argv.slice(2);
if (!dirArg) {
  console.error("用法：npm --prefix server run packplugin -- <插件目录> [输出文件] [私钥文件]");
  process.exit(2);
}
const dir = resolve(dirArg);
const pkg = await packDir(dir);

if (keyArg) {
  const key = createPrivateKey(await readFile(resolve(keyArg)));
  /* Ed25519 签名不走摘要算法 —— 第一个参数必须是 null（和 RSA/ECDSA 不同，写错会直接抛） */
  pkg.signature = edSign(null, canonical(pkg), key).toString("base64");
} else {
  console.warn("⚠️ 没给私钥，打出来的是**未签名包** —— 只能在 UMBRASTUDIO_PLUGIN_DEV=1 的机器上装");
}

const out = resolve(outArg ?? `${basename(dir)}-${pkg.manifest.version}.umbraplugin`);
const buf = encodePackage(pkg);
await writeFile(out, buf);
console.log(`✓ ${pkg.manifest.id} ${pkg.manifest.version} → ${out}`);
console.log(`  ${Object.keys(pkg.files).length} 个文件 · ${(buf.length / 1024).toFixed(1)} KB · ${pkg.signature ? "已签名" : "未签名"}`);
