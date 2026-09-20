/** AI 配置（M2-2）
 *
 * 存本地，不进任何日志、不进 changelog、不随项目走。密钥属于机器，不属于项目。
 * 存于 TOOL_ROOT/.umbradesign/ai_config.json。
 */

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROOT } from "./project.js";
import { writeAtomic } from "./normalize.js";

const CONFIG_FILE = join(TOOL_ROOT, ".umbradesign", "ai_config.json");

export interface ChannelAConfig {
  baseUrl: string;    // OpenAI 兼容端点
  apiKey: string;     // ⚠️ 密钥
  model: string;      // 用户填的模型名
}

export interface AiConfig {
  channelA: ChannelAConfig | null;
  defaultChannel: "a" | "b";
}

const DEFAULT_CONFIG: AiConfig = {
  channelA: null,
  defaultChannel: "a",
};

export async function getAiConfig(): Promise<AiConfig> {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as AiConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setAiConfig(cfg: AiConfig): Promise<void> {
  await mkdir(join(TOOL_ROOT, ".umbradesign"), { recursive: true });
  await writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** 获取通道 A 的配置，未配置时报错 */
export async function getChannelA(): Promise<ChannelAConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelA) throw new Error("通道 A 未配置：请先设置 baseUrl、apiKey 和 model");
  return cfg.channelA;
}
