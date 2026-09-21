/** 发给设计侧的稿里那行 baseline 注释：写（outgoing）与读（incoming）共用。
 *  单独成模块，是因为 outgoing.ts 有顶层副作用（一 import 就会打一次包）。 */
import { createHash } from "node:crypto";

export const BASELINE_RE =
  /<!--\s*umbradesign:baseline\s+file="([^"]+)"\s+sha="([0-9a-f]+)"(?:\s+sent="([^"]+)")?[^>]*-->\n?/;

/** 正本内容的指纹。截 16 位就够区分版本，注释也不会太长。 */
export const shaOf = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface Baseline { file: string; sha: string; sent: string | null }

export function readBaseline(src: string): Baseline | null {
  const m = BASELINE_RE.exec(src);
  return m ? { file: m[1] as string, sha: m[2] as string, sent: m[3] ?? null } : null;
}

/** 去掉 baseline 注释 —— 交回来的文件要移植进正本前，这一行必须拿掉。 */
export const stripBaseline = (src: string): string => src.replace(BASELINE_RE, "");
