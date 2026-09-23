/** AI 配置（M2-2）
 *
 * 存本地，不进任何日志、不进 changelog、不随项目走。密钥属于机器，不属于项目。
 * 存于 TOOL_ROOT/.umbrastudio/ai_config.json。
 */

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROOT } from "./project.js";
import { writeAtomic } from "./normalize.js";

const CONFIG_FILE = join(TOOL_ROOT, ".umbrastudio", "ai_config.json");

export interface ChannelAConfig {
  baseUrl: string;    // OpenAI 兼容端点
  apiKey: string;     // ⚠️ 密钥
  model: string;      // 用户填的模型名
}

/** 通道 B：Claude Code 子进程要指向的 Anthropic 兼容端点（GLM Coding Plan）。
 *  和通道 A 不是一个地址、不是一把 key —— 曾经复用 A 的配置，真跑之前必须拆开（doc/11 Q11）。 */
export interface ChannelBConfig {
  baseUrl: string;    // Anthropic 兼容端点，如 https://open.bigmodel.cn/api/anthropic
  apiKey: string;     // ⚠️ 密钥
  model: string;      // 如 glm-4.6
}

export interface AiConfig {
  channelA: ChannelAConfig | null;
  channelB: ChannelBConfig | null;
  defaultChannel: "a" | "b";
}

const DEFAULT_CONFIG: AiConfig = {
  channelA: null,
  channelB: null,
  defaultChannel: "a",
};

export async function getAiConfig(): Promise<AiConfig> {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Partial<AiConfig>;
    return { ...DEFAULT_CONFIG, ...cfg, channelB: cfg.channelB ?? null };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setAiConfig(cfg: AiConfig): Promise<void> {
  await mkdir(join(TOOL_ROOT, ".umbrastudio"), { recursive: true });
  await writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** 获取通道 B 的配置，未配置时报错（不再回落到通道 A —— 端点不同，回落只会打到错的地址） */
export async function getChannelB(): Promise<ChannelBConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelB) throw new Error("通道 B 未配置：请用 set_ai_config 传 channel=b 设置 Anthropic 兼容端点 baseUrl、apiKey 和 model");
  return cfg.channelB;
}

/** 获取通道 A 的配置，未配置时报错 */
export async function getChannelA(): Promise<ChannelAConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelA) throw new Error("通道 A 未配置：请先设置 baseUrl、apiKey 和 model");
  return cfg.channelA;
}
