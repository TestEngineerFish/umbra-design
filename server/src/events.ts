/** 核心 → 前端的事件总线（M7-4，doc/01 §4.9「前端只通过 HTTP + WS 和核心说话」）。
 *
 *  进程内一张表：谁改了什么就 emit 一条，WS 连接按项目目录订阅。
 *  事件只是「提醒」—— 前端收到后按需再走 HTTP 拉正文，所以 payload 都很小、可丢。
 *  类型：
 *    job    作业起 / 完（体检、会话）        { job }
 *    chat   会话多了一条消息                  { sessionId, entry }
 *    write  一份稿经唯一写入口落了盘          { file, version, origin }
 *    fs     项目目录里文件变了（磁盘监听）    { changes: [rel...] }
 */
export interface UdEvent { type: "job" | "chat" | "write" | "fs" | "hello"; projectDir: string | null; payload: unknown; at: string }
type Listener = (e: UdEvent) => void;
const listeners = new Set<Listener>();

export function emit(type: UdEvent["type"], projectDir: string | null, payload: unknown): void {
  const e: UdEvent = { type, projectDir, payload, at: new Date().toISOString() };
  for (const l of listeners) { try { l(e); } catch { /* 一个订阅者坏了不影响别人 */ } }
}
export function subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
