/** 探一次这条通道吃不吃图（M8-10）。
 *
 *  为什么不靠模型名猜：`deepseek-chat` 的文档没写多模态，实测**它能看图** ——
 *  有图时答「上方黑色横条，左下绿色，右下黄色」（全对），不给图时瞎编「左上红、右上蓝」
 *  （2026-09-24 有图 / 无图对照实验，`00` §六十一）。按名字猜一定会有误判，
 *  而误判的两个方向都难受：判成不支持，用户白白用不了圈选；判成支持，发出去是一条对面读不懂的消息。
 *
 *  所以给一条**硬判据**：现场造一张随机纯色小图发过去，问它什么颜色。
 *  答对了才写 `supportsImage: true`。一次调用几厘钱，比猜可靠。
 */
import { deflateSync } from "node:zlib";
import { chat } from "./provider.js";
import { getAiConfig, setAiConfig, type ChannelAConfig } from "./ai_config.js";

/** 区分度高、说法不容易撞车的六个颜色 */
const COLORS: Array<{ rgb: [number, number, number]; names: string[] }> = [
  { rgb: [0xcc, 0x22, 0x22], names: ["红", "red", "crimson"] },
  { rgb: [0x22, 0xaa, 0x44], names: ["绿", "green"] },
  { rgb: [0x22, 0x44, 0xcc], names: ["蓝", "blue"] },
  { rgb: [0xee, 0xcc, 0x22], names: ["黄", "yellow", "金"] },
  { rgb: [0xcc, 0x22, 0xaa], names: ["洋红", "品红", "紫", "magenta", "pink", "粉"] },
  { rgb: [0x22, 0xcc, 0xcc], names: ["青", "cyan", "蓝绿", "teal"] },
];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
}
/** 纯色 PNG（不引依赖 —— H2：能自己写的就别 vendor） */
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface ProbeResult {
  supportsImage: boolean;
  /** 这次问的是什么颜色、它答了什么 —— 读数要看得见，不然「探过了」等于没探 */
  asked: string;
  answered: string;
  saved: boolean;
  why: string;
}

export async function probeImageSupport(channel: "a" | "b" | "c" = "a"): Promise<ProbeResult> {
  if (channel === "b") {
    return { supportsImage: false, asked: "", answered: "", saved: false, why: "通道 B 走 Claude Code 子进程，图片支持由它那边决定，这里探不了" };
  }
  const cfg = await getAiConfig();
  const a = channel === "c" ? cfg.channelC : cfg.channelA;
  if (!a?.apiKey) return { supportsImage: false, asked: "", answered: "", saved: false, why: `通道 ${channel.toUpperCase()} 还没配` };

  const pick = COLORS[Math.floor(Math.random() * COLORS.length)]!;
  const png = solidPng(64, 64, pick.rgb);
  const dataUrl = "data:image/png;base64," + png.toString("base64");

  const r = await chat(
    { baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model },
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图是什么颜色？只回一个颜色词，别解释。" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
      maxSteps: 1,
    },
  );
  const last = [...r.messages].reverse().find((m) => m.role === "assistant");
  const answered = (typeof last?.content === "string" ? last.content : "").trim().slice(0, 80);
  if (r.error) {
    // 发不出去（4xx / 端点不认多模态）也是一种答案：不支持
    await save(channel, a, false);
    return { supportsImage: false, asked: pick.names[0]!, answered: "", saved: true, why: `这条通道拒了带图的消息：${r.error.slice(0, 120)}` };
  }
  const hit = pick.names.some((n) => answered.toLowerCase().includes(n.toLowerCase()));
  await save(channel, a, hit);
  return {
    supportsImage: hit, asked: pick.names[0]!, answered, saved: true,
    why: hit ? `发了一张纯${pick.names[0]}的图，它答「${answered}」—— 答对了` : `发了一张纯${pick.names[0]}的图，它答「${answered}」—— 没答对，按不支持算`,
  };
}

async function save(channel: "a" | "c", a: ChannelAConfig, supportsImage: boolean): Promise<void> {
  const cfg = await getAiConfig();
  const next = { ...a, supportsImage };
  await setAiConfig(channel === "c" ? { ...cfg, channelC: next } : { ...cfg, channelA: next });
}
