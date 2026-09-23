/** 通道 B · 子进程 Claude Code（M2-3）
 *
 * headless 跑，模型指向 GLM Coding Plan 的 Anthropic 兼容端点。
 * Claude Code 作为子进程，自带 agent 循环（我们不需要管）。
 * 我们的 MCP 服务器通过 --mcp-config 加载，--allowed-tools 预授权。
 *
 * 出参和通道 A 统一成 { ok, result, usage, error, interrupted }。
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChannelBConfig {
  baseUrl: string;     // GLM 的 Anthropic 兼容端点
  apiKey: string;
  model: string;       // 如 "glm-4.6"
  mcpServerPath: string;  // 我们的 MCP server dist/index.js 绝对路径
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
      umbradesign: {
        command: "node",
        args: [mcpServerPath],
      },
    },
  };
  return JSON.stringify(cfg);
}

/** 列出我们的 MCP 工具名（给 --allowed-tools 用） */
function listMcpToolNames(): string[] {
  return [
    "mcp__umbradesign__list_projects",
    "mcp__umbradesign__get_project",
    "mcp__umbradesign__list_drafts",
    "mcp__umbradesign__search_tokens",
    "mcp__umbradesign__get_token",
    "mcp__umbradesign__list_components",
    "mcp__umbradesign__get_component",
    "mcp__umbradesign__list_icons",
    "mcp__umbradesign__get_icon",
    "mcp__umbradesign__get_syntax_guide",
    "mcp__umbradesign__validate_draft",
    "mcp__umbradesign__write_draft",
    "mcp__umbradesign__patch_draft",
    "mcp__umbradesign__render_check",
    "mcp__umbradesign__list_versions",
    "mcp__umbradesign__diff_drafts",
    "mcp__umbradesign__snapshot_draft",
    "mcp__umbradesign__get_changes_since",
    "mcp__umbradesign__revert_to",
    "mcp__umbradesign__locate_node",
    "mcp__umbradesign__set_prop",
    "mcp__umbradesign__list_references",
    // 内置工具也授权，以防模型想用
    "Bash", "Read", "Edit", "Write", "mcp__umbradesign__*",
  ];
}

/** 跑一次 Claude Code 子进程，返回结果 */
export async function channelBRun(
  cfg: ChannelBConfig,
  prompt: string,
  systemPrompt?: string,
  timeoutMs: number = 120000,
): Promise<ChannelBResult> {
  /* 端点预检：Claude Code 对 4xx（尤其 429）会静默重试，外面看就是挂死到超时。
     先用一条 max_tokens=1 的最小请求问一下端点，不通就立刻把原话回给上层。
     【实测 2026-09-23】智谱 Anthropic 端点 429「GLM Coding Plan 套餐已到期」，0.4 秒就能知道，不必等 120 秒。 */
  try {
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
  const tmpDir = await mkdtemp(join(tmpdir(), "umbradesign-cc-"));
  const mcpFile = join(tmpDir, "mcp.json");
  await writeFile(mcpFile, mcpJson);

  const args = [
    "--print",
    "--output-format", "json",
    "--model", cfg.model,
    "--brief",
    "--mcp-config", mcpFile,
    "--allowed-tools", ...listMcpToolNames(),
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
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: cfg.baseUrl,
        ANTHROPIC_API_KEY: cfg.apiKey,
      },
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

      // 解析 JSON 输出（可能前面有警告行）
      const lines = stdout.trim().split("\n");
      let jsonLine: string | undefined = lines.length > 0 ? lines[lines.length - 1] : undefined;  // 最后一行应该是 JSON

      // 如果有多行，找最大的 JSON 对象
      for (const line of lines) {
        if (line.startsWith("{") && line.includes('"result"')) {
          jsonLine = line;
          break;
        }
      }

      if (!jsonLine) {
        safeResolve({
          ok: false, result: "", usage: null,
          error: `Claude Code 无输出: ${stderr.slice(0, 300)}`,
          toolCalls: [], numTurns: 0,
        });
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonLine);
      } catch {
        safeResolve({
          ok: false, result: "", usage: null,
          error: `解析 Claude Code 输出失败: ${stdout.slice(0, 500)}`,
          toolCalls: [], numTurns: 0,
        });
        return;
      }

      // 提取工具调用信息
      const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
      // 从 stderr 或 stdout 的中间行里找 tool_use 事件
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant" && obj.message?.content) {
            for (const part of obj.message.content) {
              if (part.type === "tool_use" && part.name) {
                toolCalls.push({ name: part.name, input: part.input || {} });
              }
            }
          }
        } catch { /* skip non-JSON */ }
      }

      const isOk = parsed.is_error === false && parsed.api_error_status == null;
      const usage = parsed.usage as Record<string, unknown> | undefined;

      safeResolve({
        ok: isOk,
        result: (parsed.result as string) ?? "",
        usage: usage ? {
          inputTokens: (usage.input_tokens as number) ?? 0,
          outputTokens: (usage.output_tokens as number) ?? 0,
          totalCostUSD: (parsed.total_cost_usd as number) ?? 0,
        } : null,
        error: isOk ? null : (
          parsed.api_error_status ? `API 错误 ${parsed.api_error_status}` :
          (parsed.result as string)?.slice(0, 500) ?? "未知错误"
        ),
        toolCalls,
        numTurns: (parsed.num_turns as number) ?? 0,
      });
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      safeResolve({
        ok: false, result: "", usage: null,
        error: `启动 Claude Code 失败: ${(e as Error).message}`,
        toolCalls: [], numTurns: 0,
      });
    });
  });
}
