/** 沙箱里跑的那一端（M11-4）。**这个文件跑在插件的进程里，和宿主不共享任何内存。**
 *
 *  它做三件事：把插件加载进来、把 `host` 递给它、把两边的消息转成 promise。
 *
 *  ⚠️ 这里**不做任何权限判断** —— 判断在宿主那边（`host.ts`）。
 *  在这里判等于让嫌疑人自己签字：插件和这段代码在同一个进程里，它改得动。
 */
const dir = process.env.UD_PLUGIN_DIR ?? "";
const entry = process.env.UD_PLUGIN_ENTRY ?? "";

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
type CapDef = { name: string; title: string; summary: string; input: Record<string, unknown>; run: (i: unknown) => Promise<unknown> };
const caps = new Map<string, CapDef>();

const send = (m: Record<string, unknown>) => process.send?.(m);

/** 递给插件的 `host`。**插件里一个 `import` 都不写，全部能力从这一个对象拿**
 *  —— 插件是独立更新的，和主程序必然版本错配，
 *  边界越窄，跨版本要守住的东西越少（`doc/11` Q37）。 */
const host = {
  version: 1,
  /** 调一件宿主能力。宿主那边查白名单和清单权限 */
  call(cap: string, input: unknown): Promise<unknown> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "host", id, cap, input });
    });
  },
  /** 声明一件插件自己的能力。名字**必须以插件 id 开头**（宿主会再查一遍） */
  defineCap(c: CapDef) { caps.set(c.name, c); },
};

process.on("message", async (raw: unknown) => {
  const msg = raw as Record<string, unknown>;
  if (msg.type === "host:done") {
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    p.resolve(msg.result);
    return;
  }
  const id = Number(msg.id);
  try {
    if (msg.type === "init") {
      if (entry) {
        const mod = await import(`file://${dir}/${entry}`) as { default?: (h: unknown) => void };
        if (typeof mod.default !== "function") throw new Error("插件的入口要 export default 一个 register(host) 函数");
        mod.default(host);
      }
      send({ type: "caps", caps: [...caps.values()].map(({ run: _run, ...rest }) => rest) });
      send({ id, result: { ok: true, caps: caps.size } });
      return;
    }
    if (msg.type === "invoke") {
      const c = caps.get(String(msg.cap));
      if (!c) throw new Error(`插件没有声明能力 ${String(msg.cap)}`);
      send({ id, result: await c.run(msg.input) });
      return;
    }
    throw new Error(`不认识的消息：${String(msg.type)}`);
  } catch (e) {
    send({ id, error: (e as Error).message });
  }
});
