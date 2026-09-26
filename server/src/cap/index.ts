/** 能力注册表的装配点 —— **这里是唯一知道「有哪些能力模块」的地方**。
 *
 *  加一件能力：在对应的 `cap/<域>.ts` 里 `defineCap` 一次，两个门面自动出现。
 *  新开一个域：在这里加一行 import。
 *
 *  ⚠️ 顺序无关，但**必须在两个门面初始化之前 import 到** ——
 *  `defineCap` 是 import 时执行的副作用，没 import 到的能力等于不存在。
 *  `captest` 里钉了一条判据防这个。
 */
import "./files.js";
import "./design.js";
import "./drafts.js";
import "./plugins.js";
import "./projects.js";

export { allCaps, capsFor, httpRoutes } from "./registry.js";
export { originOf, type Cap, type CapCtx, type Face } from "./types.js";
