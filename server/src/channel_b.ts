/** 通道 B · 子进程 Claude Code（M2-3）
 *
 * headless 跑。两种模式，看 `baseUrl` / `apiKey` 填没填：
 *  - **都留空 → 用本机已登录的 Claude Code**：不覆盖 `ANTHROPIC_*`，`claude` 用用户自己的订阅。
 *    不需要任何 key，也不按量扣款，但**和用户自己的 Claude Code 会话共用同一份窗口配额**。
 *    2026-09-24 实测：`claude -p` 回四个字就 21831 个 cache creation token，
 *    模型别名给 `sonnet` 而不是 `opus`，差一个量级。
 *  - **都填了 → 指向别家的 Anthropic 兼容端点**（如 GLM Coding Plan），这时才做端点预检。
 * Claude Code 作为子进程，自带 agent 循环（我们不需要管）。
 * 我们的 MCP 服务器通过 --mcp-config 加载，--allowed-tools 预授权。
 *
 * 出参和通道 A 统一成 { ok, result, usage, error, interrupted }。
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";   // 调试落盘用同步写：进程可能马上就结束了
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChannelBConfig {
  baseUrl: string;     // Anthropic 兼容端点；留空 = 用本机已登录的 Claude Code
  apiKey: string;      // 同上，留空 = 本机登录态
  model: string;       // 自带端点时如 "glm-4.6"；本机登录态时 "sonnet" / "opus" / "haiku"
  mcpServerPath: string;  // 我们的 MCP server dist/index.js 绝对路径
  /** 一轮最多花多少（美元）。只对 `--print` 有效，默认 0.5 —— 本机登录态下这是折算价，
   *  不是真扣款，但它同样是「跑飞」的刹车。 */
  maxBudgetUsd?: number;
}

/** 走本机登录态还是自带端点 —— 和 ai_config 的同名判据保持一致 */
function usesLocalLogin(cfg: ChannelBConfig): boolean {
  return !cfg.baseUrl.trim() || !cfg.apiKey.trim();
}

export interface ChannelBResult {
  ok: boolean;
  result: string;       // 模型回复文本
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUSD: number;
  } | null;
  error: string | null;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  numTurns: number;
}

/** 构建 MCP 配置 JSON（给 --mcp-config 用） */
async function buildMcpConfig(mcpServerPath: string): Promise<string> {
  const cfg = {
    mcpServers: {
      umbrastudio: {
        command: "node",
        args: [mcpServerPath],
      },
    },
  };
  return JSON.stringify(cfg);
}

/** 放行我们整台 MCP server，而不是逐个列工具名。
 *  原来这里硬编码了 23 个名字，而工具早就涨到 66 件 —— 通道 B 的 AI 因此拿不到
 *  M8 那批泛型文件工具（`list_files` / `read_file` / `write_file` / `move_file`），
 *  面对 `.md` 只会撞墙。这跟通道 A 犯过的是同一个病（`00` §六十之二）：
 *  **一张手写的工具名单，加了新工具就会忘。** 写成 server 级，名单不会过时。 */
const ALLOWED_TOOLS = "mcp__umbrastudio";

/** 跑一次 Claude Code 子进程，返回结果 */
export async function channelBRun(
  cfg: ChannelBConfig,
  prompt: string,
  systemPrompt?: string,
  timeoutMs: number = 120000,
): Promise<ChannelBResult> {
  /* 端点预检只对自带端点做 —— 本机登录态没有端点可问，登录态坏了 `claude` 自己会说。
     Claude Code 对 4xx（尤其 429）会静默重试，外面看就是挂死到超时。
     先用一条 max_tokens=1 的最小请求问一下端点，不通就立刻把原话回给上层。
     【实测 2026-09-23】智谱 Anthropic 端点 429「GLM Coding Plan 套餐已到期」，0.4 秒就能知道，不必等 120 秒。 */
  if (!usesLocalLogin(cfg)) try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.apiKey, "authorization": `Bearer ${cfg.apiKey}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const text = (await r.text().catch(() => "")).slice(0, 400);
      return { ok: false, result: "", usage: null, toolCalls: [], numTurns: 0,
        error: `通道 B 端点预检失败 HTTP ${r.status}：${text || r.statusText}` };
    }
  } catch (e) {
    return { ok: false, result: "", usage: null, toolCalls: [], numTurns: 0,
      error: `通道 B 端点预检连不上 ${cfg.baseUrl}：${(e as Error).message}` };
  }

  const mcpJson = await buildMcpConfig(cfg.mcpServerPath);

  // 写临时 MCP 配置文件
  const tmpDir = await mkdtemp(join(tmpdir(), "umbrastudio-cc-"));
  const mcpFile = join(tmpDir, "mcp.json");
  await writeFile(mcpFile, mcpJson);

  const args = [
    "--print",
    /* `stream-json` 而不是 `json`，为的是**看得见每一步**：`json` 只吐一个最终对象，
       中间的 tool_use 事件根本不存在，所以原来那段「从多行里找 assistant 事件」的解析
       永远命中不了，工具调用一律报 0（实测：文件真改了，界面上却是零工具行）。
       stream-json 要求同时给 --verbose。 */
    "--output-format", "stream-json", "--verbose",
    "--model", cfg.model,
    /* 不要 --brief：它启用 SendUserMessage，模型改用那个工具跟人说话，
       最终的 result 字段就空了（实测：改对了文件，回答却是空的）。 */
    "--mcp-config", mcpFile,
    /* 只用我们这一台 MCP server。不加这个的话子进程会把用户整套环境继承过来 ——
       实测继承了 54 台（插件 / claude.ai 连接器 / 别的项目的 server），一堆 needs-auth 与
       failed 要在启动时逐个连、超时，工具表还大得离谱。那些跟改稿一点关系都没有。 */
    "--strict-mcp-config",
    /* 同理不继承用户的 settings：hook 会往系统提示里注东西（实测把用户的「输出风格」
       整段灌进来了），CLAUDE.md 也会被读进去。这一轮只该有我们给的系统提示。 */
    "--setting-sources", "",
    /* 花钱的硬上限。agent 循环每一步都重发整段上下文，跑飞一次能烧掉一天的额度 ——
       与其事后看账单，不如让它自己停下来。 */
    "--max-budget-usd", String(cfg.maxBudgetUsd ?? 0.5),
    "--allowed-tools", ALLOWED_TOOLS,
    "--",
    prompt,
  ];

  if (systemPrompt) {
    args.splice(3, 0, "--system-prompt", systemPrompt);
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const safeResolve = (r: ChannelBResult) => {
      if (!resolved) { resolved = true; resolve(r); }
    };

    const proc = spawn("claude", args, {
      /* 本机登录态：**一个 ANTHROPIC_* 都不能设**，连空串都不行 —— 设了空的 base url
         会让 claude 去请求空地址。父进程里若已经有这几个变量（比如 Umbra 自己被
         Claude Code 起着），也要删掉，否则会串到别人的端点上去。 */
      env: usesLocalLogin(cfg)
        ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")))
        : { ...process.env, ANTHROPIC_BASE_URL: cfg.baseUrl, ANTHROPIC_API_KEY: cfg.apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      safeResolve({
        ok: false, result: "", usage: null,
        error: `超时（${timeoutMs}ms），已终止进程`,
        toolCalls: [], numTurns: 0,
      });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);

      /* 仪器要能说话：这条通道是个黑盒子（子进程 + 自带 agent 循环），出问题时
         「解析不出来」和「它真没说」长得一样。设 UMBRASTUDIO_CHANNEL_B_LOG 就把原始事件流留下。 */
      if (process.env.UMBRASTUDIO_CHANNEL_B_LOG) {
        try {
          appendFileSync(process.env.UMBRASTUDIO_CHANNEL_B_LOG,
            `\n===== ${new Date().toISOString()} exit=${code} =====\n${stdout}\n--- stderr ---\n${stderr}\n`);
        } catch { /* 记不下来就算了，不能因为记日志把这一轮搞挂 */ }
      }

      /* stream-json：一行一个事件。tool_use 散在 assistant 事件里，最后一行是 result。
         前面可能夹着非 JSON 的警告行，逐行 try 掉就好。 */
      const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
      const texts: string[] = [];
      let final: Record<string, any> | null = null;
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let obj: any;
        try { obj = JSON.parse(t); } catch { continue; }
        if (obj.type === "assistant") {
          for (const part of obj.message?.content ?? []) {
            if (part.type === "tool_use" && part.name) {
              // 工具名去掉 mcp__umbrastudio__ 前缀，和通道 A / C 的工具行对齐
              toolCalls.push({ name: String(part.name).replace(/^mcp__umbrastudio__/, ""), input: part.input ?? {} });
            } else if (part.type === "text" && part.text?.trim()) {
              texts.push(part.text.trim());
            }
          }
        } else if (obj.type === "result") {
          final = obj;
        }
      }

      if (!final) {
        safeResolve({
          ok: false, result: texts.join("\n\n"), usage: null,
          error: code === 0
            ? `Claude Code 没给出 result 事件${stderr ? `：${stderr.slice(0, 300)}` : ""}`
            : `Claude Code 退出码 ${code}${stderr ? `：${stderr.slice(0, 300)}` : ""}`,
          toolCalls, numTurns: 0,
        });
        return;
      }

      /* 预算用完是**正常收尾**，不是崩溃 —— 要把原话传上去，不然用户只看到「失败」，
         不知道是自己设的刹车起了作用。 */
      const budgetHit = /budget/i.test(String(final.terminal_reason ?? "")) || /budget/i.test(String(final.result ?? ""));
      const u = final.usage ?? {};
      safeResolve({
        ok: final.is_error !== true,
        // result 是模型的最终回答；空的时候退回中途说过的话，总比什么都没有好
        result: String(final.result ?? "").trim() || texts.join("\n\n"),
        usage: {
          /* 只算**真正新处理**的：新 input + 新建缓存。cache read 不计入 ——
             它按 10% 计价，量却常常是十几万，加进来会让「这一轮多贵」这个读数虚高一个量级
             （实测一轮：input 10 · cache creation 22k · cache read 118k，折算 $0.072）。
             要看权威花费就看 totalCostUSD，那是 Claude Code 自己按当时价目算的。 */
          inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          totalCostUSD: Number(final.total_cost_usd ?? 0),
        },
        error: final.is_error === true
          ? `Claude Code 报错：${String(final.result ?? final.terminal_reason ?? "没说原因").slice(0, 300)}`
          : budgetHit
            ? `这一轮撞到预算上限（maxBudgetUsd）停了：${String(final.result ?? "").slice(0, 200)}`
            : null,
        toolCalls,
        numTurns: Number(final.num_turns ?? 0),
      });
    });
  });
}
