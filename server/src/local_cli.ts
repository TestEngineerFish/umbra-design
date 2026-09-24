/** 本地 CLI 通道（M2-13）：把装在这台机器上的 AI CLI 当通道用。
 *
 *  ## 为什么这条路值得走
 *
 *  这些 CLI 自带 agent 循环，而且**都能加载 MCP server** —— 也就是说它们能用上我们那 66 件工具。
 *  更要紧的是**它们走的是登录态，不是 API key**：用户已经在付的订阅（Claude、ChatGPT、Cursor…）
 *  能直接用上，不必再按量买 token。
 *
 *  Cursor 就是个好例子：它的 **API** 接不进来（Cloud Agent API 没有 `/chat/completions`
 *  也没有 `/v1/messages`，实测都 404，`00` §64.1），但它的 **CLI** 完全可以（`00` §六十五）。
 *  「这家接不进来」和「这家的 API 接不进来」是两件事。
 *
 *  ## 五家的能力不齐，差在三处
 *
 *  1. **MCP 怎么接进去**。只有 Claude Code 能纯命令行给（`--mcp-config`），别家都得落一个配置文件。
 *     落在工作目录里（cursor 的 `.cursor/mcp.json`）还能接受；要写用户全局配置的（gemini）就得声明清楚。
 *  2. **输出有多结构化**。有 JSON 事件流才看得见工具行；纯文本的只能拿到最后一段话。
 *  3. **报不报 token 用量**。cursor-agent 不报，所以「这一轮多贵」那个读数会是空的 —— 空就写空，别编。
 *
 *  ## 纪律
 *
 *  `verified` 字段只在**这台机器上真跑通过**才是 true。按文档写出来的适配器一律 false，
 *  界面上要照实说「没实测过」—— 一个装得像验过的适配器比没有更糟。
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type CliId = "claude" | "cursor-agent" | "codex" | "gemini" | "opencode";

/** MCP 怎么接进去 —— 直接决定「用它要不要动你的文件」 */
export type McpVia =
  | "flag"            // 命令行参数，什么都不落盘（最干净）
  | "workspace-file"  // 往工作目录写配置（项目内，可接受，但要说）
  | "global-config";  // 往用户全局配置写（侵入，默认不做）

export interface CliSpec {
  id: CliId;
  label: string;
  bin: string;
  versionArgs: string[];
  /** 能不能问它「有哪些模型可用」。有就别让用户猜 ——
   *  实测填 `sonnet-4` 被 cursor-agent 顶回来：`Cannot use this model. Available models: auto, composer-2.5, …`
   *  可用模型是**按账号**来的，写死在 modelHint 里一定会过时。 */
  listModelsArgs?: string[];
  /** 拿版本号的正则（各家 --version 的话术不一样） */
  versionRe?: RegExp;
  mcpVia: McpVia;
  /** 输出的结构化程度：events 才看得见工具行 */
  output: "events" | "text";
  /** 报不报 token 用量 / 花费 */
  reportsUsage: boolean;
  /** 在这台机器上真跑通过没有 */
  verified: boolean;
  /** 模型名的例子，填配置时给个提示 */
  modelHint: string;
  /** 怎么登录（用户要自己做的那一步） */
  loginHint: string;
  /** 已知的坑与限制，直接显示给用户 */
  note: string;
}

export const CLI_SPECS: readonly CliSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    versionArgs: ["--version"],
    mcpVia: "flag",
    output: "events",
    reportsUsage: true,
    verified: true,
    modelHint: "sonnet / opus / haiku",
    loginHint: "在终端跑一次 claude 登录即可；已登录就直接能用",
    note: "唯一能纯命令行给 MCP 的（--mcp-config），不往你的目录写任何东西。用量与花费都报。",
  },
  {
    id: "cursor-agent",
    label: "Cursor CLI",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    mcpVia: "workspace-file",
    output: "events",
    reportsUsage: false,
    verified: true,
    listModelsArgs: ["--list-models"],
    modelHint: "auto / composer-2.5（按账号，点「列一下」看真实清单）",
    loginHint: "终端跑 cursor-agent login（浏览器授权，用你的 Cursor 订阅）；或设 CURSOR_API_KEY",
    note: "MCP 要在项目里放 .cursor/mcp.json —— 我们会写这一个键，你原有的别的 server 不动。不报 token 用量。",
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    versionArgs: ["--version"],
    mcpVia: "global-config",
    output: "events",
    reportsUsage: false,
    verified: false,
    modelHint: "gpt-5-codex / o4-mini",
    loginHint: "终端跑 codex login（ChatGPT 账号授权，用你的订阅）",
    note: "【没实测】按文档：codex exec --json --cd <目录>。MCP 要先 codex mcp add 写进 ~/.codex/config.toml，我们不替你改全局配置 —— 你自己加一次即可。",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    versionArgs: ["--version"],
    mcpVia: "global-config",
    output: "text",
    reportsUsage: false,
    verified: false,
    modelHint: "gemini-2.5-pro / gemini-2.5-flash",
    loginHint: "终端跑一次 gemini 走 Google 登录",
    note: "【没实测】而且它只输出纯文本，没有 JSON 事件 —— 界面上看不到工具行，只能看到最后一段话。MCP 要 gemini mcp add 写进全局 settings。",
  },
  {
    id: "opencode",
    label: "opencode",
    bin: "opencode",
    versionArgs: ["--version"],
    mcpVia: "workspace-file",
    output: "events",
    reportsUsage: false,
    verified: false,
    listModelsArgs: ["models"],
    modelHint: "anthropic/claude-sonnet-4 等 provider/model",
    loginHint: "opencode auth 配一个 provider",
    note: "【没实测】按文档：opencode run --format json。MCP 配在项目的 opencode.json。",
  },
] as const;

export function specOf(id: CliId): CliSpec {
  const s = CLI_SPECS.find((x) => x.id === id);
  if (!s) throw new Error(`不认识的 CLI：${id}`);
  return s;
}

/* ─────────────────── 扫描这台机器装了什么 ─────────────────── */

export interface CliStatus extends CliSpec {
  installed: boolean;
  /** 可执行文件在哪 */
  path: string | null;
  /** --version 的输出（截一段） */
  version: string | null;
}

/** 扫一遍。**只回答「装了没」，不回答「登录了没」** ——
 *  判登录得真发一次请求，那要花钱也要花时间，不该塞在一个列清单的接口里。
 *  登录状态由用户点「试一次」按钮时探（和 probe_image_support 一个道理）。 */
export async function detectLocalClis(): Promise<CliStatus[]> {
  return await Promise.all(CLI_SPECS.map(async (spec) => {
    let path: string | null = null;
    try {
      const { stdout } = await exec("sh", ["-c", `command -v ${spec.bin}`], { timeout: 4000 });
      path = stdout.trim() || null;
    } catch { path = null; }
    let version: string | null = null;
    if (path) {
      try {
        const { stdout, stderr } = await exec(spec.bin, spec.versionArgs, { timeout: 8000 });
        const raw = (stdout || stderr || "").trim().split("\n")[0] ?? "";
        version = spec.versionRe ? (raw.match(spec.versionRe)?.[0] ?? raw) : raw.slice(0, 60);
      } catch { version = null; }
    }
    return { ...spec, installed: !!path, path, version };
  }));
}

/** 问这个 CLI 有哪些模型可用。列不出来就回空数组 —— 拿不到清单不是错误，只是没有清单。
 *  输出要剥 ANSI：cursor-agent 会往里塞光标控制符（`\x1b[2K\x1b[G` 那类），
 *  不剥的话模型名会带着一串乱码进配置。 */
export async function listCliModels(cli: CliId): Promise<string[]> {
  const spec = specOf(cli);
  if (!spec.listModelsArgs) return [];
  try {
    const { stdout, stderr } = await exec(spec.bin, spec.listModelsArgs, { timeout: 25000, maxBuffer: 4 << 20 });
    const clean = (stdout || stderr || "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")   // ANSI 光标控制符（cursor-agent 会塞 \x1b[2K\x1b[G）
      .replace(/[\u200b-\u200f\u2060]/g, "")    // 零宽字符：它的显示名里真的有（"Grok 4.7 Low Fast\u200b\u200b"）
      .replace(/\r/g, "\n");
    return [...new Set(clean.split("\n").map((line) => {
      // 一行的形状是 `<id> - <显示名>`（cursor-agent）或干脆只有 id
      const id = (line.split(/\s+[-—]\s+/)[0] ?? "").trim().replace(/^[*•\s]+/, "");
      return /^[a-z0-9][\w./:-]{1,60}$/i.test(id) ? id : "";
    }).filter(Boolean))];
  } catch { return []; }   // 列不出来不是错误，只是没有清单（opencode 的 models 子命令自己就会崩）
}

/* ─────────────────── 起一轮 ─────────────────── */

export interface CliRunOptions {
  cli: CliId;
  model: string;
  /** 我们的 MCP server 入口（dist/index.js 绝对路径） */
  mcpServerPath: string;
  /** 工作目录 —— 一般给项目目录 */
  cwd: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  /** 只有 claude 用：指向别家 Anthropic 兼容端点。留空 = 用本机登录态 */
  baseUrl?: string;
  apiKey?: string;
  /** 原始事件流落盘到哪（调试用）。这类通道是黑盒，没有原始流就只能猜 */
  logFile?: string;
}

export interface CliRunResult {
  ok: boolean;
  result: string;
  usage: { inputTokens: number; outputTokens: number; totalCostUSD: number } | null;
  error: string | null;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  numTurns: number;
  /** 为了这一轮往用户目录里写过哪些文件 —— 要能说得出来 */
  wroteFiles: string[];
}

const MCP_NAME = "umbrastudio";

/** MCP 配置的内容，各家形状一样（都是 mcpServers 那套） */
function mcpEntry(mcpServerPath: string) {
  return { command: "node", args: [mcpServerPath] };
}

/** 往工作目录写 MCP 配置。
 *  **必须合并** —— 用户自己的 `.cursor/mcp.json` 里可能已经有别的 server，
 *  整份覆盖等于替他删掉。读不动或者解析不了就不动那个文件，宁可这一轮跑不起来。 */
async function ensureWorkspaceMcp(cwd: string, rel: string, mcpServerPath: string, shape: "mcpServers" | "mcp"): Promise<string[]> {
  const file = join(cwd, rel);
  let doc: Record<string, any> = {};
  if (existsSync(file)) {
    try { doc = JSON.parse(await readFile(file, "utf8")); } catch {
      throw new Error(`${rel} 解析不了（可能手改坏了）。我不会覆盖它 —— 请你自己看一眼，或者先把它挪走`);
    }
  }
  const key = shape;
  const cur = doc[key] ?? {};
  const want = mcpEntry(mcpServerPath);
  // 已经一样就什么都不写 —— 幂等，免得每轮都动用户的文件
  if (JSON.stringify(cur[MCP_NAME]) === JSON.stringify(want)) return [];
  doc[key] = { ...cur, [MCP_NAME]: want };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
  return [rel];
}

interface Built {
  args: string[];
  env: NodeJS.ProcessEnv;
  wroteFiles: string[];
  /** 临时文件目录（用完不删也无所谓，系统会清） */
  tmp?: string;
}

async function build(o: CliRunOptions): Promise<Built> {
  const spec = specOf(o.cli);
  const localLogin = !o.baseUrl?.trim() || !o.apiKey?.trim();
  /* 本机登录态时**一个 ANTHROPIC_* 都不能留**，连空串都不行：设了空 base url 会让它去请求空地址，
     而父进程里已有的（Umbra 自己可能正被 Claude Code 起着）会把这一轮串到别人的端点上。 */
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")));

  switch (o.cli) {
    case "claude": {
      const tmp = await mkdtemp(join(tmpdir(), "umbrastudio-cli-"));
      const mcpFile = join(tmp, "mcp.json");
      await writeFile(mcpFile, JSON.stringify({ mcpServers: { [MCP_NAME]: mcpEntry(o.mcpServerPath) } }));
      return {
        tmp, wroteFiles: [],
        env: localLogin ? cleanEnv : { ...process.env, ANTHROPIC_BASE_URL: o.baseUrl, ANTHROPIC_API_KEY: o.apiKey },
        args: [
          "--print",
          // stream-json 才有 tool_use 事件；json 只吐一个最终对象（`00` §64.3 第 3 条）
          "--output-format", "stream-json", "--verbose",
          "--model", o.model,
          "--system-prompt", o.systemPrompt,
          // 只用我们这一台 MCP server：不加的话会继承用户整套环境（实测 54 台）
          "--strict-mcp-config",
          // 不继承用户 settings：hook 会往系统提示里灌东西
          "--setting-sources", "",
          "--max-budget-usd", String(o.maxBudgetUsd ?? 0.5),
          "--mcp-config", mcpFile,
          // server 级放行，别写工具名单 —— 名单会过时（`00` §64.3 第 2 条）
          "--allowed-tools", `mcp__${MCP_NAME}`,
          "--", o.prompt,
        ],
      };
    }
    case "cursor-agent": {
      const wrote = await ensureWorkspaceMcp(o.cwd, join(".cursor", "mcp.json"), o.mcpServerPath, "mcpServers");
      return {
        wroteFiles: wrote,
        env: cleanEnv,
        args: [
          "--print",
          "--output-format", "stream-json",
          "--model", o.model,
          // headless 下必须自动批准，否则等一个永远不会来的确认
          "--approve-mcps", "--force",
          "--workspace", o.cwd,
          // 它没有 --system-prompt，只能把要求并进 prompt
          `${o.systemPrompt}\n\n---\n\n${o.prompt}`,
        ],
      };
    }
    case "codex": {
      return {
        wroteFiles: [],
        env: cleanEnv,
        args: [
          "exec", "--json",
          "--cd", o.cwd,
          "--model", o.model,
          "--ask-for-approval", "never",
          `${o.systemPrompt}\n\n---\n\n${o.prompt}`,
        ],
      };
    }
    case "gemini": {
      return {
        wroteFiles: [],
        env: cleanEnv,
        args: ["--yolo", "--model", o.model, "--prompt", `${o.systemPrompt}\n\n---\n\n${o.prompt}`],
      };
    }
    case "opencode": {
      const wrote = await ensureWorkspaceMcp(o.cwd, "opencode.json", o.mcpServerPath, "mcp");
      return {
        wroteFiles: wrote,
        env: cleanEnv,
        args: ["run", "--format", "json", "--model", o.model, `${o.systemPrompt}\n\n---\n\n${o.prompt}`],
      };
    }
    default: { const _never: never = o.cli; throw new Error(`没实现：${String(_never)}`); }
  }
}

/* ─────────────────── 解析输出 ─────────────────── */

type Parsed = Omit<CliRunResult, "wroteFiles">;

/** Claude Code 的 stream-json */
function parseClaude(stdout: string, code: number | null, stderr: string): Parsed {
  const toolCalls: CliRunResult["toolCalls"] = [];
  const texts: string[] = [];
  let final: Record<string, any> | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim(); if (!t.startsWith("{")) continue;
    let j: any; try { j = JSON.parse(t); } catch { continue; }
    if (j.type === "assistant") {
      for (const part of j.message?.content ?? []) {
        if (part.type === "tool_use" && part.name) toolCalls.push({ name: String(part.name).replace(/^mcp__umbrastudio__/, ""), input: part.input ?? {} });
        else if (part.type === "text" && part.text?.trim()) texts.push(part.text.trim());
      }
    } else if (j.type === "result") final = j;
  }
  if (!final) {
    return { ok: false, result: texts.join("\n\n"), usage: null, toolCalls, numTurns: 0,
      error: code === 0 ? `没给出 result 事件${stderr ? `：${stderr.slice(0, 300)}` : ""}` : `退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ""}` };
  }
  const u = final.usage ?? {};
  const budgetHit = /budget/i.test(String(final.terminal_reason ?? "")) || /budget/i.test(String(final.result ?? ""));
  return {
    ok: final.is_error !== true,
    result: String(final.result ?? "").trim() || texts.join("\n\n"),
    /* cache read 不计入：按 10% 计价、量却常常十几万，加进来让「这一轮多贵」虚高一个量级 */
    usage: { inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0), totalCostUSD: Number(final.total_cost_usd ?? 0) },
    error: final.is_error === true ? `Claude Code 报错：${String(final.result ?? final.terminal_reason ?? "没说原因").slice(0, 300)}`
      : budgetHit ? `这一轮撞到预算上限（maxBudgetUsd）停了：${String(final.result ?? "").slice(0, 200)}` : null,
    toolCalls,
    numTurns: Number(final.num_turns ?? 0),
  };
}

/** cursor-agent 的 stream-json。
 *  形状和 Claude Code 像但有三处不同（实测 `00` §65.2）：
 *  工具调用在 `tool_call` 事件里而不是 assistant 的 content 里；MCP 工具名带 `umbrastudio-` 前缀
 *  （不是 `mcp__umbrastudio__`）；**result 事件不报 usage** —— 空就写 null，别编一个 0 出来。 */
function parseCursor(stdout: string, code: number | null, stderr: string): Parsed {
  const toolCalls: CliRunResult["toolCalls"] = [];
  const seen = new Set<string>();
  const texts: string[] = [];
  let final: Record<string, any> | null = null;
  let turns = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim(); if (!t.startsWith("{")) continue;
    let j: any; try { j = JSON.parse(t); } catch { continue; }
    if (j.type === "tool_call" && j.subtype === "started") {
      // 内置工具的 tool_call 是空对象，只有 MCP 调用才有 mcpToolCall —— 我们只关心后者
      const mc = j.tool_call?.mcpToolCall?.args;
      if (mc?.name && !seen.has(String(j.call_id))) {
        seen.add(String(j.call_id));
        toolCalls.push({ name: String(mc.name).replace(/^umbrastudio[-_]+/, ""), input: mc.args ?? {} });
      }
    } else if (j.type === "assistant") {
      turns++;
      for (const part of j.message?.content ?? []) if (part.type === "text" && part.text?.trim()) texts.push(part.text.trim());
    } else if (j.type === "result") final = j;
  }
  if (!final) {
    return { ok: false, result: texts.join("\n\n"), usage: null, toolCalls, numTurns: turns,
      error: code === 0 ? `没给出 result 事件${stderr ? `：${stderr.slice(0, 300)}` : ""}` : `退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ""}` };
  }
  return {
    ok: final.is_error !== true && final.subtype !== "error",
    result: String(final.result ?? "").trim() || texts.join("\n\n"),
    usage: null,   // cursor-agent 不报用量。报 null，界面上就写「这条通道不报用量」
    error: final.is_error === true || final.subtype === "error" ? `Cursor CLI 报错：${String(final.result ?? final.subtype).slice(0, 300)}` : null,
    toolCalls,
    numTurns: turns,
  };
}

/** codex `exec --json` / opencode `run --format json`：都是 NDJSON，但字段名没实测过。
 *  兜底策略：**把能认出来的认出来，认不出来的老实说**，别猜出一个像样的结果来骗自己。 */
function parseNdjsonGeneric(label: string, stdout: string, code: number | null, stderr: string): Parsed {
  const toolCalls: CliRunResult["toolCalls"] = [];
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim(); if (!t.startsWith("{")) continue;
    let j: any; try { j = JSON.parse(t); } catch { continue; }
    const name = j.tool_name ?? j.name ?? j.tool?.name ?? j.tool_call?.name;
    if (/tool/i.test(String(j.type ?? "")) && name) toolCalls.push({ name: String(name).replace(/^umbrastudio[-_]+/, ""), input: j.input ?? j.args ?? j.arguments ?? {} });
    for (const k of ["text", "message", "content", "delta", "result"]) {
      const v = j[k];
      if (typeof v === "string" && v.trim() && !/^\{/.test(v.trim())) { texts.push(v.trim()); break; }
    }
  }
  const joined = texts.join("\n").trim();
  return {
    ok: code === 0 && !!joined,
    result: joined || stdout.trim().slice(-2000),
    usage: null,
    toolCalls,
    numTurns: 0,
    error: code === 0
      ? (joined ? null : `${label} 跑完了但没解析出回答 —— 这个适配器没实测过，请把原始输出（UMBRASTUDIO_CHANNEL_B_LOG）发给开发侧`)
      : `${label} 退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ""}`,
  };
}

/** 纯文本输出（gemini）：拿不到工具行，只有最后这段话 */
function parseText(label: string, stdout: string, code: number | null, stderr: string): Parsed {
  const out = stdout.trim();
  return {
    ok: code === 0 && !!out, result: out, usage: null, toolCalls: [], numTurns: 0,
    error: code === 0 ? (out ? null : `${label} 没有输出`) : `${label} 退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ""}`,
  };
}

function parse(cli: CliId, stdout: string, code: number | null, stderr: string): Parsed {
  switch (cli) {
    case "claude": return parseClaude(stdout, code, stderr);
    case "cursor-agent": return parseCursor(stdout, code, stderr);
    case "codex": return parseNdjsonGeneric("Codex CLI", stdout, code, stderr);
    case "opencode": return parseNdjsonGeneric("opencode", stdout, code, stderr);
    case "gemini": return parseText("Gemini CLI", stdout, code, stderr);
  }
}

/** 跑一轮。失败一律回成 CliRunResult，不抛 —— 上层要把原话给用户看。 */
export async function runLocalCli(o: CliRunOptions): Promise<CliRunResult> {
  const spec = specOf(o.cli);
  let built: Built;
  try { built = await build(o); } catch (e) {
    return { ok: false, result: "", usage: null, toolCalls: [], numTurns: 0, wroteFiles: [], error: (e as Error).message };
  }

  return await new Promise<CliRunResult>((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (r: Omit<CliRunResult, "wroteFiles">) => {
      if (done) return; done = true;
      if (o.logFile) {
        try {
          // 同步写：进程可能马上就结束了。**别在这里用 require** —— dist 是 ESM，会直接抛还被 catch 吞掉
          appendFileSync(o.logFile, `\n===== ${new Date().toISOString()} ${o.cli} =====\n${stdout}\n--- stderr ---\n${stderr}\n`);
        } catch { /* 记不下来也不能把这一轮搞挂 */ }
      }
      resolve({ ...r, wroteFiles: built.wroteFiles });
    };

    const proc = spawn(spec.bin, built.args, {
      env: built.env,
      cwd: o.cwd,
      /* stdin 给 ignore（= /dev/null）。这些 CLI 的 headless 模式都会**等 stdin**，
         不给就干等到超时 —— cursor-agent 第一次实测就是这么卡了 240 秒（`00` §65.2）。 */
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      finish({ ok: false, result: "", usage: null, toolCalls: [], numTurns: 0, error: `${spec.label} 超时（${o.timeoutMs}ms），已终止` });
    }, o.timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, result: "", usage: null, toolCalls: [], numTurns: 0,
        error: (e as NodeJS.ErrnoException).code === "ENOENT"
          ? `这台机器上没有 ${spec.bin}（${spec.label}）。${spec.loginHint}`
          : `起不来 ${spec.bin}：${e.message}` });
    });
    proc.on("close", (code) => { clearTimeout(timer); finish(parse(o.cli, stdout, code, stderr)); });
  });
}
