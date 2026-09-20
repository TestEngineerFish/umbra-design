/** 通道 A · provider 适配器（M2-1）
 *
 * 走 OpenAI Chat Completions 形状，覆盖 DeepSeek、智谱通用 API、任何 OpenAI 兼容端点。
 * 模型名由用户配置，不硬编码（§六）。
 *
 * 出参是统一的对话结果，上层（agent 循环 / MCP 工具）不关心具体是哪家 provider。
 */

export interface ProviderConfig {
  baseUrl: string;     // e.g. "https://api.deepseek.com/v1"
  apiKey: string;
  model: string;       // 用户填的，不硬编码
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResult {
  ok: boolean;
  messages: ChatMessage[];   // 包括模型回复
  usage: UsageInfo | null;
  error: string | null;
  interrupted: boolean;
}

export interface ProviderOpts {
  systemPrompt?: string;
  messages: ChatMessage[];   // 已有的对话历史
  tools?: ToolDef[];         // 可用工具定义
  maxSteps?: number;         // agent 循环最大步数（默认 10）
  onToolCall?: (toolCall: ToolCall) => Promise<string>;  // 工具调用回调
  abortSignal?: AbortSignal;
}

export async function chat(
  cfg: ProviderConfig,
  opts: ProviderOpts,
): Promise<ProviderResult> {
  const maxSteps = opts.maxSteps ?? 10;
  const messages: ChatMessage[] = [
    ...(opts.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
    ...opts.messages,
  ];
  const allMessages: ChatMessage[] = [...messages];
  let totalUsage: UsageInfo | null = null;
  let step = 0;

  while (step < maxSteps) {
    if (opts.abortSignal?.aborted) {
      return { ok: true, messages: allMessages, usage: totalUsage, error: null, interrupted: true };
    }

    const res = await singleRequest(cfg, allMessages, opts.tools, opts.abortSignal);
    if (!res.ok) {
      return { ok: false, messages: allMessages, usage: totalUsage, error: res.error, interrupted: false };
    }

    // 累加用量
    if (res.usage) {
      if (!totalUsage) totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      totalUsage.promptTokens += res.usage.promptTokens;
      totalUsage.completionTokens += res.usage.completionTokens;
      totalUsage.totalTokens += res.usage.totalTokens;
    }

    // 追加模型回复
    const reply = res.message;
    allMessages.push(reply);

    // 如果没有 tool_calls，对话结束
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      return { ok: true, messages: allMessages, usage: totalUsage, error: null, interrupted: false };
    }

    // 有 tool_calls，执行工具
    if (!opts.onToolCall) {
      // 没有工具回调，把工具调用结果直接返回给上层
      return { ok: true, messages: allMessages, usage: totalUsage, error: null, interrupted: false };
    }

    const toolResults: ChatMessage[] = [];
    for (const tc of reply.tool_calls) {
      if (opts.abortSignal?.aborted) {
        return { ok: true, messages: allMessages, usage: totalUsage, error: null, interrupted: true };
      }
      const result = await opts.onToolCall(tc);
      toolResults.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
        name: tc.function.name,
      });
    }
    allMessages.push(...toolResults);
    step++;
  }

  return { ok: true, messages: allMessages, usage: totalUsage, error: null, interrupted: false };
}

// ── 单次请求 ──

interface SingleResult {
  ok: boolean;
  message: ChatMessage;
  usage: UsageInfo | null;
  error: string | null;
}

async function singleRequest(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  signal?: AbortSignal,
): Promise<SingleResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id, name: m.name } : {}),
    })),
    stream: false,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const resp = await fetch(new URL("/chat/completions", cfg.baseUrl).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, message: { role: "assistant", content: null }, usage: null, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }

  const json = await resp.json() as Record<string, unknown>;
  const choice = (json.choices as any[])?.[0];
  if (!choice?.message) {
    return { ok: false, message: { role: "assistant", content: null }, usage: null, error: "No choices in response" };
  }

  const msg = choice.message as { role: string; content: string | null; tool_calls?: ToolCall[] };
  const usage = json.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

  return {
    ok: true,
    message: {
      role: msg.role as ChatMessage["role"],
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    },
    usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : null,
    error: null,
  };
}
