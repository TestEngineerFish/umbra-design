/** 核心返回的形状（与 server/src/api.ts 一一对应；只写前端用到的字段） */
export type Health = "ok" | "warn" | "error" | "unchecked";

export interface Draft {
  file: string; title: string; kind: "page" | "component"; health: Health; healthWhy: string;
  diagnostics: { errors: number; warnings: number }; elements: number | null; version: string | null;
  updatedAt: string | null; states: string[]; imports: string[]; importedBy: string[];
}
export interface Diag { level: "error" | "warning" | "info"; code?: string; message: string; fix?: string; line?: number; col?: number }
export interface Comment { id: string; file: string; node: string; tag?: string; text: string; createdAt: string; resolved: boolean }
export interface ChangeRow { level?: string; at?: string; message: string }
export interface VersionMeta { src?: string; time?: string; summary?: string; note?: string }
export interface ChangesData { file: string; versions: string[]; versionMeta: Record<string, VersionMeta>; diff?: { changes: Array<{ level?: string; at?: string; message?: string; target?: string; kind?: string }> } }
export interface SourceData { file: string; source: string; lines: number; bytes: number }
export interface Picked { file: string; node: string; tag: string }
/** 带进会话的选择项（S9 第五轮：五种）。`node` 来自 S2 点选桥；其余四种随 M8 的类型接入。
 *  `ref` 是给后端的定位信息：node 走 selectedNodeFile / selectedNodeAddress，别的类型 M8 再定。 */
export type SelectionKind = "node" | "range" | "region" | "files" | "dir";
export interface Selection { kind: SelectionKind; label: string; detail: string; ref?: { file?: string; node?: string }; /** region 药丸：裁出来的那一块（data URL），通道支持图片时随消息发过去 */ image?: string }
export const SELECTION_ICON: Record<SelectionKind, string> = { node: "⌖", range: "≡", region: "▢", files: "⧉", dir: "▤" };

/** 泛型文件层（M8，server/src/files.ts 的返回形状） */
export type FileKindS = "dir" | "dc" | "md" | "image" | "code" | "html" | "other";
export interface FileEntry { path: string; name: string; kind: FileKindS; isDir: boolean; size: number; updatedAt: string; count?: number; width?: number; height?: number; excerpt?: string; snapshot?: string }
export interface ListFilesResult { dir: string; entries: FileEntry[]; types: { dc: number; md: number; image: number; other: number } }
export interface ReadFileResult { path: string; kind: FileKindS; size: number; updatedAt: string; sha256: string; content: string | null; why?: string; lines?: number; snapshot?: string; width?: number; height?: number }
export interface FileSnapshotMeta { version: string; src: string; at: string; bytes: number; note?: string }
export interface ShellState { selectOn: boolean; preset: number; zoom: number; draftTheme: "light" | "dark"; picked: boolean; busy: boolean; editHint: string | null; checkNote: string | null; apiErr: string | null }

export interface ToolCall { id: string; function?: { name?: string; arguments?: string } }
export interface ChatMessage { role: "user" | "assistant" | "tool" | "system"; content: string; timestamp?: string; toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string }
export interface ChatSessionRow { id: string; title?: string; updatedAt?: string; channel?: string }
export interface ChatNote { kind: "change" | "err"; idx: number; path?: string; from?: string; to?: string; summary?: string; reverted?: boolean; text?: string }
export interface ChatUsage { totalTokens?: number; totalCostUSD?: number }

export interface ProjectRow { name: string; title: string; dir: string; drafts?: number; lastOpened?: string | null; missing?: boolean; thumb?: string | null; current?: boolean; generatedAt?: string | null }
export interface DirInfo { dir: string; exists: boolean; isDir: boolean; isProject: boolean; draftCount: number; suggestedName: string }

export const baseName = (p: string) => (p ? p.split("/").pop()!.split("\\").pop()! : "");
export const draftTitle = (file: string) => baseName(file).replace(/\.dc\.html$/, "");
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "刚刚"; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`; return new Date(iso).toLocaleDateString();
}
export const HEALTH_LABEL: Record<Health, string> = { ok: "通过", warn: "有提醒", error: "有错误", unchecked: "未体检" };
