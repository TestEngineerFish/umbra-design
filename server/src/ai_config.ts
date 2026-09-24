/** AI 配置（M2-2）
 *
 * 存本地，不进任何日志、不进 changelog、不随项目走。密钥属于机器，不属于项目。
 * 存于 STATE_ROOT/.umbrastudio/ai_config.json（开发时 = 仓库根；打包后 = 壳给的 userData，
 * 因为写进 .app 会毁掉 ad-hoc 签名，见 project.ts 的 STATE_ROOT）。
 */

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./project.js";
import { writeAtomic } from "./normalize.js";

const CONFIG_FILE = join(STATE_ROOT, ".umbrastudio", "ai_config.json");

export interface ChannelAConfig {
  baseUrl: string;    // OpenAI 兼容端点
  apiKey: string;     // ⚠️ 密钥
  model: string;      // 用户填的模型名
  /** 这个模型吃不吃图（M8-10）。不给时按模型名猜 —— 猜不准就当不支持，
   *  宁可把入口灰掉说清楚，也不要发一条对面读不懂的多模态消息。 */
  supportsImage?: boolean;
}

/** 通道 B：Claude Code 子进程要指向的 Anthropic 兼容端点（GLM Coding Plan）。
 *  和通道 A 不是一个地址、不是一把 key —— 曾经复用 A 的配置，真跑之前必须拆开（doc/11 Q11）。 */
export interface ChannelBConfig {
  /** Anthropic 兼容端点，如 `https://open.bigmodel.cn/api/anthropic`。
   *  **留空 = 用本机已登录的 Claude Code**（`claude` 子进程不覆盖 `ANTHROPIC_*`，走用户自己的订阅）。 */
  baseUrl: string;
  /** ⚠️ 密钥。`baseUrl` 留空时这里也留空。 */
  apiKey: string;
  /** 自带端点时是端点的模型名（如 `glm-4.6`）；本机登录态时是 Claude Code 认的别名
   *  （`sonnet` / `opus` / `haiku`）—— 默认给 `sonnet`，Opus 一条回复能吃掉几万 cache token。 */
  model: string;
}

/** 这条通道走的是本机 Claude Code 的登录态，还是自带的 Anthropic 兼容端点？ */
export function channelBUsesLocalLogin(cfg: ChannelBConfig): boolean {
  return !cfg.baseUrl.trim() || !cfg.apiKey.trim();
}

/** 通道 C：另一条 OpenAI 兼容端点，和 A 完全同形 —— 存在的理由是**订阅额度**：
 *  先用包月的那条，额度用完了自动退回按量计费的 A（`11` Q33）。
 *  火山方舟 Agent Plan 的地址是 `https://ark.cn-beijing.volces.com/api/plan/v1`
 *  （`/api/plan` 下还有一条 Anthropic 形状的 `/v1/messages`，我们用 OpenAI 那条）。 */
export type ChannelCConfig = ChannelAConfig;

export interface AiConfig {
  channelA: ChannelAConfig | null;
  channelB: ChannelBConfig | null;
  channelC?: ChannelCConfig | null;
  defaultChannel: "a" | "b" | "c";
}

const DEFAULT_CONFIG: AiConfig = {
  channelA: null,
  channelB: null,
  channelC: null,
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
  await mkdir(join(STATE_ROOT, ".umbrastudio"), { recursive: true });
  await writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** 获取通道 B 的配置，未配置时报错（不再回落到通道 A —— 端点不同，回落只会打到错的地址） */
export async function getChannelB(): Promise<ChannelBConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelB) throw new Error("通道 B 未配置：set_ai_config channel=b。要用本机已登录的 Claude Code 就把 baseUrl 与 apiKey 留空、model 给 sonnet；要用别家的 Anthropic 兼容端点就三个都填");
  return cfg.channelB;
}

/** 获取通道 A 的配置，未配置时报错 */
/** 模型名里认得出的多模态家族。认不出就是 false —— 判断要往保守那边倒。 */
const IMAGE_MODEL_RE = /(vl|vision|gpt-4o|gpt-4\.1|gpt-5|o[34]|claude-|gemini|qwen.*-vl|glm-4v|step-1v|internvl|llava|pixtral|grok.*vision)/i;
export function channelSupportsImage(c: { model: string; supportsImage?: boolean } | null): boolean {
  if (!c) return false;
  if (typeof c.supportsImage === "boolean") return c.supportsImage;   // 用户说了算
  return IMAGE_MODEL_RE.test(c.model);
}

export async function getChannelA(): Promise<ChannelAConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelA) throw new Error("通道 A 未配置：请先设置 baseUrl、apiKey 和 model");
  return cfg.channelA;
}

export async function getChannelC(): Promise<ChannelCConfig> {
  const cfg = await getAiConfig();
  if (!cfg.channelC) throw new Error("通道 C 未配置：请先设置 baseUrl、apiKey 和 model");
  return cfg.channelC;
}

/** A 与 C 同形（都是 OpenAI 兼容），取哪一条只看通道名 */
export async function getOpenAiChannel(ch: "a" | "c"): Promise<ChannelAConfig> {
  return ch === "c" ? getChannelC() : getChannelA();
}

/** 这条错误像不像「订阅额度用完 / 被限流」—— 像才降级，别把参数错、网络抖动也当额度问题。
 *  命中就换通道重试一次；没命中就照原样报错，原文也一并留给用户看。 */
export function looksLikeQuotaProblem(error: string): boolean {
  return /(quota|exceed|insufficient|balance|欠费|余额|额度|用完|超出|限流|rate.?limit|too many requests|\b429\b|\b402\b)/i.test(error);
}
