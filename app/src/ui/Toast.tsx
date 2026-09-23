import { useEffect, useState } from "react";

/** 页面内提示：host.notify 在浏览器里的退化路径也落到这里（监听 ud-toast） */
export function Toasts() {
  const [items, setItems] = useState<{ id: number; title: string; body?: string; kind?: string }[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {}; const id = Date.now() + Math.random();
      setItems((xs) => [...xs, { id, title: d.title ?? String(d), body: d.body, kind: d.kind }]);
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener("ud-toast", on); return () => window.removeEventListener("ud-toast", on);
  }, []);
  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className={`rounded-lg border px-3 py-2 text-xs shadow-lg bg-panel ${t.kind === "error" ? "border-err text-err" : "border-border text-text"}`}>
          <div className="font-semibold">{t.title}</div>{t.body && <div className="text-muted mt-0.5">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
export function toast(title: string, body?: string, kind?: "error" | "ok") { window.dispatchEvent(new CustomEvent("ud-toast", { detail: { title, body, kind } })); }
