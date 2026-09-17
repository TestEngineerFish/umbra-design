/** 统一返回信封。doc/00 §四 —— 所有工具的返回都是这个形状。
 *
 * 两条铁律：
 *  1. 不许在 ok:true 的同时藏一条 error。`envelope()` 由 errors 自动决定 ok。
 *  2. line/col 定位不到就省略，**不许填 0 或猜**。
 */
import type { Code } from "./codes.js";

export type Level = "error" | "warning";

export type LocatorKind = "hole" | "tag" | "import" | "key" | "token" | "file" | "path";

export interface Locator {
  kind: LocatorKind;
  name: string;
}

export interface Diagnostic {
  code: Code;
  level: Level;
  /** 仓库根的相对路径 */
  file: string;
  /** 1 起。定位不到就不给这个字段 */
  line?: number;
  /** 1 起 */
  col?: number;
  locator: Locator;
  /** 人话，一句，说清是什么 */
  message: string;
  /** 给模型的改法。没有可靠改法就省略，不许写「请检查代码」 */
  fix?: string;
}

export interface Envelope<T = unknown> {
  ok: boolean;
  data: T;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  stats: Record<string, unknown>;
}

export function diag(
  code: Code,
  level: Level,
  file: string,
  locator: Locator,
  message: string,
  opts: { line?: number; col?: number; fix?: string } = {}
): Diagnostic {
  const d: Diagnostic = { code, level, file, locator, message };
  if (Number.isInteger(opts.line) && (opts.line as number) > 0) d.line = opts.line;
  if (Number.isInteger(opts.col) && (opts.col as number) > 0) d.col = opts.col;
  if (opts.fix) d.fix = opts.fix;
  return d;
}

export const err = (
  code: Code, file: string, locator: Locator, message: string,
  opts?: { line?: number; col?: number; fix?: string }
) => diag(code, "error", file, locator, message, opts);

export const warn = (
  code: Code, file: string, locator: Locator, message: string,
  opts?: { line?: number; col?: number; fix?: string }
) => diag(code, "warning", file, locator, message, opts);

export function envelope<T>(
  data: T,
  diags: Diagnostic[] = [],
  stats: Record<string, unknown> = {}
): Envelope<T> {
  const errors = diags.filter((d) => d.level === "error");
  const warnings = diags.filter((d) => d.level === "warning");
  return { ok: errors.length === 0, data, errors, warnings, stats };
}

/** 工具抛出的、带结构化诊断的失败。index.ts 捕获后装进信封。 */
export class ToolError extends Error {
  constructor(readonly diagnostic: Diagnostic, readonly data: unknown = null) {
    super(diagnostic.message);
    this.name = "ToolError";
  }
}

/** MCP 的 content 载荷：信封的 JSON。模型要能机器解析，所以只给 JSON，不给散文。 */
export function toContent(env: Envelope<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(env, null, 1) }],
    isError: !env.ok,
  };
}
