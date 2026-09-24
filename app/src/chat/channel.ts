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
