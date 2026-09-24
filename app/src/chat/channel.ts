import { mem } from "../layout/layout";

export type ChannelId = "a" | "b" | "c";

/** 会话栏此刻用哪条通道。
 *
 *  规则只有一条，但**必须只写一遍**：`us.chatChannel` 有值就是用户手动选过的，以它为准；
 *  没值表示「还没选过，跟后端的 defaultChannel 走」。
 *  2026-09-24 就是因为设置面板里另写了一遍（直接读 mem，拿到默认的 "a"），
 *  出现「横条说在用通道 A，左下角写着通道 C」——**同一个问题在两处各判一次，迟早对不上**。 */
export function currentChannel(defaultChannel?: ChannelId | null): ChannelId {
  const saved = mem.get<string | null>("us.chatChannel", null);
  if (saved === "a" || saved === "b" || saved === "c") return saved;
  return defaultChannel ?? "a";
}

/** 用户手动选了一条通道：记下来（从此不再跟随 defaultChannel），并通知正在跑的会话。 */
export function pickChannel(c: ChannelId): void {
  mem.set("us.chatChannel", c);
  window.dispatchEvent(new CustomEvent("ud-pick-channel", { detail: c }));
}

/** 界面上怎么称呼「此刻在用哪个引擎」：**引擎名 · 模型（有的话）· 计费方式**（设计侧第六轮 6.4）。
 *
 *  引擎名由服务端给（`caps[channel].engine`），前端**不抄第二份映射表** ——
 *  抄了就会出现「会话栏说 Claude Code、图片视图说通道 B」这种两处各写一遍的老毛病。
 *  第六轮改名时图片视图那一处就是漏的，M8-14 收进来。 */
export function engineLabel(caps: Record<string, { engine?: string; billing?: string } | undefined> | null | undefined, channel: ChannelId, model?: string): string {
  const cap = caps?.[channel];
  return [cap?.engine ?? `引擎 ${channel.toUpperCase()}`, model || null, cap?.billing].filter(Boolean).join(" · ");
}
