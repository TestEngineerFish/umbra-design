"""把 doc/19 里的 Python 代码抠出来，拿真实事件流样本跑一遍。
代码交出去之前必须自己跑过 —— 文档里跑不通的代码比没有更糟。"""
import json, re, shutil, subprocess, sys

# ── 原样复制 doc/19 §二 的 detect ──
SPECS = [
    {"id": "claude", "bin": "claude", "label": "Claude Code"},
    {"id": "codex", "bin": "codex", "label": "Codex CLI"},
    {"id": "cursor-agent", "bin": "cursor-agent", "label": "Cursor CLI"},
    {"id": "gemini", "bin": "gemini", "label": "Gemini CLI"},
    {"id": "opencode", "bin": "opencode", "label": "opencode"},
]

def detect():
    out = []
    for s in SPECS:
        path = shutil.which(s["bin"])
        ver = None
        if path:
            try:
                r = subprocess.run([s["bin"], "--version"], capture_output=True, text=True, timeout=8)
                ver = (r.stdout or r.stderr).strip().splitlines()[0][:60]
            except Exception:
                pass
        out.append({**s, "installed": bool(path), "path": path, "version": ver})
    return out

# ── 原样复制 doc/19 §4.4 的 parse_events ──
def parse_events(cli: str, stdout: str) -> dict:
    tool_calls, texts = [], []
    usage, final, failed = None, None, None
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            j = json.loads(line)
        except json.JSONDecodeError:
            continue
        if cli == "claude":
            if j.get("type") == "assistant":
                for part in (j.get("message") or {}).get("content") or []:
                    if part.get("type") == "tool_use" and part.get("name"):
                        tool_calls.append({"name": part["name"], "input": part.get("input") or {}})
                    elif part.get("type") == "text" and part.get("text", "").strip():
                        texts.append(part["text"].strip())
            elif j.get("type") == "result":
                final = j
                u = j.get("usage") or {}
                usage = {"input": (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
                         "output": u.get("output_tokens") or 0,
                         "cost_usd": j.get("total_cost_usd") or 0}
        elif cli == "cursor-agent":
            if j.get("type") == "tool_call" and j.get("subtype") == "started":
                mc = ((j.get("tool_call") or {}).get("mcpToolCall") or {}).get("args")
                if mc and mc.get("name"):
                    tool_calls.append({"name": mc["name"], "input": mc.get("args") or {}})
            elif j.get("type") == "assistant":
                for part in (j.get("message") or {}).get("content") or []:
                    if part.get("type") == "text" and part.get("text", "").strip():
                        texts.append(part["text"].strip())
            elif j.get("type") == "result":
                final = j
        elif cli == "codex":
            if j.get("type") == "item.completed":
                it = j.get("item") or {}
                if it.get("type") == "mcp_tool_call" and it.get("tool"):
                    tool_calls.append({"name": it["tool"], "input": it.get("arguments") or {}})
                elif it.get("type") == "agent_message" and it.get("text", "").strip():
                    texts.append(it["text"].strip())
            elif j.get("type") == "turn.completed":
                final = j
                u = j.get("usage") or {}
                usage = {"input": max(0, (u.get("input_tokens") or 0) - (u.get("cached_input_tokens") or 0)),
                         "output": (u.get("output_tokens") or 0) + (u.get("reasoning_output_tokens") or 0),
                         "cost_usd": 0}
            elif j.get("type") == "turn.failed":
                failed = str((j.get("error") or {}).get("message") or j.get("error"))
    text = ""
    if cli == "claude" and final:
        text = (final.get("result") or "").strip()
    elif cli == "cursor-agent" and final:
        text = (final.get("result") or "").strip()
    text = text or "\n\n".join(texts)
    return {"ok": bool(text) and not failed, "text": text, "tool_calls": tool_calls,
            "usage": usage, "error": failed}

def strip_prefix(name: str, mcp_name: str) -> str:
    return re.sub(rf"^(mcp__)?{re.escape(mcp_name)}[-_]+", "", name)

# ═══ 跑 ═══
ok = True
def check(cond, label, detail=""):
    global ok
    if not cond: ok = False
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))

print("§二 detect()")
rows = detect()
for r in rows:
    print(f"  {'✓' if r['installed'] else '·'} {r['id']:<13} {r['version'] or '(没装)'}")
check(any(r["installed"] for r in rows), "至少认出一个已装的 CLI")

SP = sys.argv[1] if len(sys.argv)>1 else 'doc/_samples'
print("\n§4.4 parse_events() —— 拿真实事件流样本跑")

with open(f"{SP}/cursor-agent.jsonl", encoding="utf-8") as f:
    r = parse_events("cursor-agent", f.read())
names = [strip_prefix(t["name"], "umbrastudio") for t in r["tool_calls"]]
check(r["ok"], "cursor-agent：解析出最终文本", repr(r["text"][:36]))
check(names == ["read_file", "write_file"], "cursor-agent：工具链", " → ".join(names))
check(r["usage"] is None, "cursor-agent：usage 是 None（它确实不报，没编 0）")

with open(f"{SP}/codex.jsonl", encoding="utf-8") as f:
    r = parse_events("codex", f.read())
names = [strip_prefix(t["name"], "umbrastudio") for t in r["tool_calls"]]
check(r["ok"], "codex：解析出最终文本", repr(r["text"][:36]))
check(names == ["get_project", "read_file", "write_file"], "codex：工具链", " → ".join(names))
check(r["usage"] is not None and r["usage"]["input"] > 0, "codex：usage 扣掉了缓存命中",
      f"input {r['usage']['input']}（原始 input_tokens 含 cached）" if r["usage"] else "")

# claude 的样本：b_raw.log 里有 stream-json（带 ===== 分隔的多轮，取最后一轮）
with open(f"{SP}/claude.jsonl", encoding="utf-8") as f:
    last = f.read()
r = parse_events("claude", last)
names = [strip_prefix(t["name"], "umbrastudio") for t in r["tool_calls"]]
check(r["ok"], "claude：解析出最终文本", repr(r["text"][:36]))
check("write_file" in names, "claude：工具链里有 write_file", " → ".join(names))
check(r["usage"] is not None and r["usage"]["cost_usd"] > 0, "claude：usage 带折算金额",
      f"${r['usage']['cost_usd']:.4f} · input {r['usage']['input']}" if r["usage"] else "")

print(f"\n{'✓ doc/19 里的 Python 代码全部跑通' if ok else '✗ 有判据没过'}")
sys.exit(0 if ok else 1)
