import type { z } from "zod";
import type { Envelope } from "../envelope.js";
import type { Project } from "../project.js";
import type { VersionOrigin } from "../history.js";

/** 一件能力面向的门面（Q36 / Q37）。
 *
 *  同一套核心现在有三个门面，以前是**各手写一遍**：
 *
 *  | 门面 | 谁在用 | 原来在哪 |
 *  | --- | --- | --- |
 *  | `mcp` | 外部模型客户端（Claude Code / Cursor…） | `index.ts` 66 个 `registerTool` |
 *  | `http` | 我们自己的前端 | `api.ts` 63 条 `route === …` |
 *  | `plugin` | 买来装上的格式插件（Q37，尚未启用） | —— |
 *
 *  两个门面手写的代价实测过：M8 那批往 `api.ts` 补了五条 MCP 侧**早就有**的能力 ——
 *  没有任何机制保证两边一致，只能等谁发现少了什么。
 */
export type Face = "mcp" | "http" | "plugin";

export interface CapCtx {
  /** `scope: "project"` 的能力这里一定不是 null（门面负责保证） */
  project: Project | null;
  /** **谁在调。** 这是三个门面之间**唯一真实的差异** ——
   *  实测一对 `write_file` / `file_write`：两侧都是 `writeAnyFile` 的薄包装，
   *  差别只有 changelog 里记 `origin: "AI"` 还是 `"人手改"`，其余全是样板。 */
  via: Face;
  /** 本地服务的端口与令牌。少数能力要把它们回给调用方（比如 `open_project`） */
  port?: number;
  token?: string;
}

/** 写盘类能力记 changelog 用的「谁改的」。门面只给 `via`，转成人话在这里统一，
 *  免得每件能力自己写一遍 —— 写法不一致的后果是变更清单里同一件事有两种说法。 */
export const originOf = (via: Face): VersionOrigin =>
  via === "mcp" ? "AI" : via === "plugin" ? "插件" : "人手改";

export interface Cap<I extends z.ZodRawShape = z.ZodRawShape> {
  /** 规范名 = MCP 工具名（动作在前：`write_file`）。全局唯一 */
  name: string;
  title: string;
  /** MCP 的 description。写清**什么时候该用它**，不是复述名字 */
  summary: string;
  /** 入参。⚠️ **`scope: "project"` 的不要在这里写 `project`** ——
   *  MCP 门面会自动注入 `project: z.string()` 并解析成 `ctx.project`；
   *  HTTP 门面从服务自己的项目上下文取。写进来就会在 MCP 侧出现两个 project。 */
  input: I;
  scope: "global" | "project";
  /** HTTP 门面怎么暴露。**路由名和工具名可以不同** ——
   *  HTTP 习惯资源在前（`file_write`），MCP 习惯动作在前（`write_file`），两种都对。
   *  统一成一个反而要改一堆前端调用点，而那不是这次要解决的问题。
   *  `method` 决定两件事：GET 走查询串、POST 走 body 且门面替它查 Origin。 */
  http?: { route?: string; method: "GET" | "POST" };
  /** 暴露给哪几个门面。不给 = `["mcp", "http"]` */
  faces?: Face[];
  run(input: z.infer<z.ZodObject<I>>, ctx: CapCtx): Promise<Envelope<unknown>>;
}
