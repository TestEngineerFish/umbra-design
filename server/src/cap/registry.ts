import type { Cap, Face } from "./types.js";

/** 能力注册表（Q36）。**一件能力一处声明，三个门面各自遍历生成。**
 *
 *  用户 2026-09-26 的原话是「加新东西要改的地方太散」——
 *  目标不是让文件短一点，是让「加一件能力」只动一个地方。
 */
const CAPS = new Map<string, Cap>();

export function defineCap(c: Cap): Cap {
  if (CAPS.has(c.name)) throw new Error(`能力重名：${c.name}`);
  CAPS.set(c.name, c);
  return c;
}

export const allCaps = (): Cap[] => [...CAPS.values()];

/** 某个门面要暴露的那些 */
export const capsFor = (face: Face): Cap[] =>
  allCaps().filter((c) => (c.faces ?? ["mcp", "http"]).includes(face));

/** HTTP 路由名 → 能力。路由名可以和工具名不同（见 `Cap.http`） */
export function httpRoutes(): Map<string, Cap> {
  const m = new Map<string, Cap>();
  for (const c of capsFor("http")) {
    if (!c.http) continue;
    const r = c.http.route ?? c.name;
    if (m.has(r)) throw new Error(`HTTP 路由重名：${r}`);
    m.set(r, c);
  }
  return m;
}
