/** 打完包立刻补一次**完整的** ad-hoc 签名（M9-4）。
 *
 *  为什么要补：`identity: null` 下 electron-builder 不签名，产物只剩 Electron 二进制出厂时的
 *  linker 签名 —— 它签的是那个可执行文件，**不覆盖我们塞进 Resources 的 core/**。
 *  于是 `codesign -v --deep --strict` 报
 *  「code has no resources but signature indicates they must be present」，
 *  用户下载后双击看到的是**「已损坏，移到废纸篓」**，右键打开也救不回来（实测）。
 *
 *  补签之后签名自洽。Gatekeeper 依然会拦 —— ad-hoc 没有 Apple 证书也没公证，这是必然的 ——
 *  但拦的理由从「已损坏」变成「无法验证开发者」，右键打开或系统设置里放行就能用。
 *  要彻底不拦得买开发者证书走 notarytool 公证，那是另一件事（`doc/12` M9-5）。
 */
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  // 签完立刻自己验一次：签名坏掉和签名没签在下游长得一样，不验等于没签
  execFileSync("codesign", ["-v", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`  • ad-hoc 签名已补并自洽  ${app.replace(process.cwd() + "/", "")}`);
};
