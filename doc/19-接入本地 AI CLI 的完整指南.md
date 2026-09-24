# 接入本地 AI CLI 的完整指南

> **这份文档是独立的** —— 不需要了解 Umbra Studio 就能用，拷到任何项目里都成立。
> 知识来自 2026-09-24 在 Umbra Studio 上的实测（`doc/00` §六十四、§六十五、§66.4），
> 写出来是为了**让下一个人不用重踩一遍**。
>
> 凡标【实测】的是真跑出来的读数；标【未实测】的是照文档写的，**别当成验过的**。

---

## 〇、一句话

这些 CLI（`claude` / `codex` / `cursor-agent` / `gemini` / `opencode`）都能 **headless 跑**、
都吐**结构化事件**、而且**走的是用户自己的登录态而不是 API key** ——
也就是说：**用户已经在付的订阅（Claude / ChatGPT / Cursor）能直接用上，不必再按量买 token。**

这是它比直连 API 划算的全部理由。如果你的用户没有这些订阅，这条路没有意义，直接用 API 更简单。

---

## 一、先分岔：你要的是 A 还是 B

这一步决定工作量差 5 倍，**先想清楚再动手**。

| | **A 类：只要文本** | **B 类：让 AI 调你的工具** |
| --- | --- | --- |
| 场景 | 给一段 prompt，拿一段回答（生成、改写、总结、分类） | AI 要读写你的文件 / 调你的接口 / 多轮自主干活 |
| 要不要 MCP | **不要** | **要**（给它一台 MCP server） |
| 工作量 | 半天 | 两三天，坑全在这一层 |
| 五家都能用吗 | 能 | 实测过三家 |

**互动小说 / 内容生成类的项目多半是 A 类。** 如果你只是要"给设定生成一段剧情"，
不要碰 MCP —— 那是给"AI 要自己动手改东西"准备的。

A 类看 §三，B 类看 §四，两类都要看 §五的坑和 §六的验证。

---

## 二、五家的能力矩阵（2026-09-24 实测）

| CLI | 非交互 | 结构化输出 | MCP 注入方式 | 免确认 | 报用量 | 实测 |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** `claude` | `-p` | `--output-format stream-json`（要配 `--verbose`） | **`--mcp-config <file>`**（纯命令行，不落盘） | `--allowed-tools mcp__<名>` | ✅ 含折算金额 | ✅ |
| **Codex CLI** `codex` | `exec` | `--json`（NDJSON） | **`-c mcp_servers.<名>.<键>=<值>`**（临时注入） | `--approve-for-me` | ✅ 含缓存命中 | ✅ |
| **Cursor CLI** `cursor-agent` | `-p` | `--output-format stream-json` | 项目里的 `.cursor/mcp.json`（**要写文件**） | `--approve-mcps --force` | ❌ | ✅ |
| **Gemini CLI** `gemini` | `-p` | ❌ **只有纯文本** | `gemini mcp add` → 全局 settings | `--yolo` | ❌ | 【未实测】 |
| **opencode** | `run` | `--format json` | 项目里的 `opencode.json` | — | ❌ | 【未实测】 |

三条结论：

1. **只有 Claude Code 和 Codex 能纯命令行注入 MCP**，不碰用户的任何配置文件。
   Cursor / opencode 必须往工作目录写配置 —— 可以接受，但**写之前必须合并**（见 §5.9）。
2. **Gemini 没有结构化输出** —— 拿不到工具调用事件，界面上没法显示"它在干什么"。A 类可用，B 类基本不可用。
3. **只有 Claude Code 和 Codex 报 token 用量。** 拿不到就写 `null`，**别编一个 0 出来**。

### 检测装了哪些

```python
import shutil, subprocess

SPECS = [
    {"id": "claude",       "bin": "claude",       "label": "Claude Code"},
    {"id": "codex",        "bin": "codex",        "label": "Codex CLI"},
    {"id": "cursor-agent", "bin": "cursor-agent", "label": "Cursor CLI"},
    {"id": "gemini",       "bin": "gemini",       "label": "Gemini CLI"},
    {"id": "opencode",     "bin": "opencode",     "label": "opencode"},
]

def detect():
    out = []
    for s in SPECS:
        path = shutil.which(s["bin"])
        ver = None
        if path:
            try:
                r = subprocess.run([s["bin"], "--version"], capture_output=True,
                                   text=True, timeout=8)
                ver = (r.stdout or r.stderr).strip().splitlines()[0][:60]
            except Exception:
                pass
        out.append({**s, "installed": bool(path), "path": path, "version": ver})
    return out
```

**只回答"装了没"，不回答"登录了没"** —— 判登录要真发一次请求，那要花钱也要花时间，
不该塞在一个列清单的接口里。登录状态让用户点一下"试一次"再探。

---

## 三、A 类接入：只要文本（半天）

### 最小实现

```python
import subprocess, json

def run_text(cli: str, prompt: str, model: str = "", timeout: int = 240) -> str:
    """跑一轮，拿最终文本。失败抛异常，异常里带原话。"""
    if cli == "claude":
        args = ["claude", "--print", "--output-format", "json"]
        if model: args += ["--model", model]
        args += ["--", prompt]
    elif cli == "codex":
        args = ["codex", "exec", "--json", "--skip-git-repo-check"]
        if model: args += ["--model", model]
        args += [prompt]
    elif cli == "cursor-agent":
        args = ["cursor-agent", "--print", "--output-format", "json"]
        if model: args += ["--model", model]
        args += [prompt]
    elif cli == "gemini":
        args = ["gemini", "--yolo"] + (["--model", model] if model else []) + ["--prompt", prompt]
    else:
        raise ValueError(f"不认识的 CLI: {cli}")

    r = subprocess.run(
        args,
        capture_output=True, text=True, timeout=timeout,
        stdin=subprocess.DEVNULL,        # ← 关键，见 §5.1
        env=clean_env(cli),              # ← 关键，见 §5.2
    )
    if r.returncode != 0:
        raise RuntimeError(f"{cli} 退出码 {r.returncode}：{r.stderr[:300]}")
    return parse_final_text(cli, r.stdout)
```

### 各家的"最终文本"在哪

```python
def parse_final_text(cli: str, stdout: str) -> str:
    if cli == "gemini":
        return stdout.strip()                    # 纯文本，没结构

    if cli in ("claude", "cursor-agent"):
        # --output-format json：整个 stdout 是一个 JSON 对象
        obj = json.loads(stdout.strip())
        if obj.get("is_error"):
            raise RuntimeError(f"{cli} 报错：{str(obj.get('result'))[:300]}")
        return (obj.get("result") or "").strip()

    if cli == "codex":
        # --json：NDJSON，最终文本在 item.completed / agent_message 里
        texts = []
        for line in stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                j = json.loads(line)
            except json.JSONDecodeError:
                continue
            if j.get("type") == "item.completed":
                it = j.get("item") or {}
                if it.get("type") == "agent_message" and it.get("text", "").strip():
                    texts.append(it["text"].strip())
            elif j.get("type") == "turn.failed":
                raise RuntimeError(f"Codex 报错：{str(j.get('error'))[:300]}")
        return "\n\n".join(texts)
    raise ValueError(cli)
```

Codex 还有个更省事的办法：`-o/--output-last-message <文件>`，它把最终回答直接写进那个文件。

---

## 四、B 类接入：让 AI 调你的工具

前提：**你得先有一台 MCP server。** 如果还没有，先做那个 —— 这份文档不讲怎么写 MCP server。

### 4.1 Claude Code（最干净）

```python
import json, tempfile, os

def claude_args(prompt: str, system_prompt: str, mcp_server_cmd: list[str],
                mcp_name: str, model: str = "", max_budget_usd: float = 0.5) -> list[str]:
    cfg = {"mcpServers": {mcp_name: {"command": mcp_server_cmd[0],
                                     "args": mcp_server_cmd[1:]}}}
    fd, path = tempfile.mkstemp(suffix=".json"); os.write(fd, json.dumps(cfg).encode()); os.close(fd)

    args = [
        "claude", "--print",
        # stream-json 才有 tool_use 事件；json 只吐一个最终对象（§5.4）
        "--output-format", "stream-json", "--verbose",
        "--system-prompt", system_prompt,
        # 只用我们这一台 MCP。不加会继承用户整套环境（§5.3）
        "--strict-mcp-config",
        # 不继承用户 settings：hook 会往系统提示里灌东西（§5.3）
        "--setting-sources", "",
        # 花钱的硬上限，只对 --print 有效
        "--max-budget-usd", str(max_budget_usd),
        "--mcp-config", path,
        # server 级放行，别写工具名单（§5.5）
        "--allowed-tools", f"mcp__{mcp_name}",
    ]
    if model:
        args += ["--model", model]
    args += ["--", prompt]
    return args
```

### 4.2 Codex CLI（次干净，但参数有三个坑）

```python
def codex_args(prompt: str, system_prompt: str, mcp_server_cmd: list[str],
               mcp_name: str, cwd: str, model: str = "") -> list[str]:
    args = [
        "codex", "exec", "--json",
        "--skip-git-repo-check",     # 工作目录未必是 git 仓库
        "--ignore-user-config",      # 不拉用户全局的 MCP（§5.3）—— 登录态不受影响
        "--approve-for-me",          # 不是 -c approval_policy=never（§5.6）
        "-C", cwd,
        # MCP 注入必须是分开的 dotted path（§5.7）
        "-c", f'mcp_servers.{mcp_name}.command="{mcp_server_cmd[0]}"',
        "-c", f"mcp_servers.{mcp_name}.args={json.dumps(mcp_server_cmd[1:])}",
    ]
    if model:
        args += ["--model", model]
    # codex exec 没有 --system-prompt，只能并进 prompt
    args += [f"{system_prompt}\n\n---\n\n{prompt}"]
    return args
```

验证注入有没有生效，**在真跑之前**就能查：

```bash
codex -c mcp_servers.<名>.command="node" -c 'mcp_servers.<名>.args=["/path/to/server.js"]' mcp list
```

你的 server 出现在列表里且 `enabled`，才算注进去了。

### 4.3 Cursor CLI（要往工作目录写 `.cursor/mcp.json`）

```python
import json, os

def ensure_cursor_mcp(cwd: str, mcp_name: str, cmd: list[str]) -> list[str]:
    """返回"写了哪些文件"——动了用户的目录就要能说得出来。"""
    path = os.path.join(cwd, ".cursor", "mcp.json")
    doc = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except Exception:
            # 解析不了就别覆盖，宁可这一轮跑不起来（§5.9）
            raise RuntimeError(f"{path} 解析不了，不覆盖它，请人工看一眼")
    servers = doc.get("mcpServers") or {}
    want = {"command": cmd[0], "args": cmd[1:]}
    if servers.get(mcp_name) == want:
        return []                                   # 幂等：一样就不写
    servers[mcp_name] = want                        # ← 合并，不是整份替换
    doc["mcpServers"] = servers
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    return [".cursor/mcp.json"]

def cursor_args(prompt: str, system_prompt: str, cwd: str, model: str = "") -> list[str]:
    args = ["cursor-agent", "--print", "--output-format", "stream-json",
            "--approve-mcps", "--force", "--workspace", cwd]
    if model:
        args += ["--model", model]
    # 它没有 --system-prompt，只能并进 prompt
    args += [f"{system_prompt}\n\n---\n\n{prompt}"]
    return args
```

### 4.4 解析事件流：三家形状都不一样

```python
def parse_events(cli: str, stdout: str) -> dict:
    """统一成 {ok, text, tool_calls, usage, error}。"""
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
                # cache_read 不计入：按 10% 计价、量却十几万，加进来虚高一个量级（§5.10）
                usage = {
                    "input": (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
                    "output": u.get("output_tokens") or 0,
                    "cost_usd": j.get("total_cost_usd") or 0,
                }

        elif cli == "cursor-agent":
            # 工具调用在独立事件里，不在 assistant 的 content 里（§5.8）
            if j.get("type") == "tool_call" and j.get("subtype") == "started":
                mc = ((j.get("tool_call") or {}).get("mcpToolCall") or {}).get("args")
                if mc and mc.get("name"):
                    tool_calls.append({"name": mc["name"], "input": mc.get("args") or {}})
            elif j.get("type") == "assistant":
                for part in (j.get("message") or {}).get("content") or []:
                    if part.get("type") == "text" and part.get("text", "").strip():
                        texts.append(part["text"].strip())
            elif j.get("type") == "result":
                final = j                      # 注意：它不报 usage，usage 保持 None

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
                # cached_input_tokens 是【包含在】input_tokens 里的，要减掉（§5.10）
                usage = {
                    "input": max(0, (u.get("input_tokens") or 0) - (u.get("cached_input_tokens") or 0)),
                    "output": (u.get("output_tokens") or 0) + (u.get("reasoning_output_tokens") or 0),
                    "cost_usd": 0,             # codex 不报折算金额
                }
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
```

**工具名前缀三家不一样**，剥的时候要认全：

```python
import re
def strip_prefix(name: str, mcp_name: str) -> str:
    # Claude: mcp__<名>__read_file ｜ Cursor: <名>-read_file ｜ Codex: read_file（已经是裸名）
    return re.sub(rf"^(mcp__)?{re.escape(mcp_name)}[-_]+", "", name)
```

---

## 五、十个坑（全部实测踩过）

### 5.1 headless 模式会等 stdin ⭐ 最容易误判

`claude -p` 和 `cursor-agent -p` 都会**等标准输入**。不给就干等到超时 ——
第一次实测 `cursor-agent` 干等了 **240 秒**，差点被判成"这条路不通"。

- 代码里：`stdin=subprocess.DEVNULL`
- 命令行手测：`< /dev/null`

### 5.2 环境变量会串台

如果你的服务**本身就跑在某个 AI CLI 里**（比如被 Claude Code 起着），
父进程里可能已经有 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`。
子进程继承过去，就会把这一轮**串到别人的端点上**。

想用登录态时，**一个都不能留，连空串都不行**（设了空的 base url 会让它去请求空地址）：

```python
def clean_env(cli: str) -> dict:
    env = dict(os.environ)
    if cli == "claude":
        for k in list(env):
            if k.startswith("ANTHROPIC_"):
                del env[k]
    return env
```

### 5.3 子进程会继承用户整套环境 ⭐ 又慢又贵又会用错工具

不隔离的话，它会把用户全局配的 MCP server 全拉进来。

【实测】Claude Code 继承了 **54 台** MCP server（各种插件、连接器），
一堆 `needs-auth` / `failed` 要在启动时逐个连、超时。

【实测】Codex 不加 `--ignore-user-config` 时，input token 从 130098 涨到 163045（**白费 3 万**），
而且**它会用错工具** —— 那一轮它拿别人的 `js` 工具去改文件，最后报"未授权使用 XXX"。

- Claude Code：`--strict-mcp-config` + `--setting-sources ""`
- Codex：`--ignore-user-config`（登录态不受影响，auth 走 `CODEX_HOME`）
- Cursor：没有对应开关，只能接受

### 5.4 `--output-format json` 拿不到工具调用

`json` 模式**只吐一个最终对象**，中间的 tool_use 事件根本不存在。
如果你想在界面上显示"它正在调什么工具"，必须用 `stream-json`（Claude / Cursor）或 `--json`（Codex）。

症状很迷惑：**文件真的被改了，但你的工具调用列表是空的**。

### 5.5 别手写工具白名单

`--allowed-tools` 写成一个个工具名，加了新工具就会忘。
写 **server 级**：`--allowed-tools mcp__<你的server名>`。

【实测】这个坑我们犯过两次 —— 第一次列表停在 23 个而实际有 66 个工具，
AI 拿不到其中 43 件，面对新类型的文件只会撞墙。

### 5.6 `approval_policy=never` 是「从不批准」不是「无需询问」⭐ 语义陷阱

Codex 上设 `-c approval_policy=never`，**MCP 调用会直接不可用**。
【实测】那一轮它绕去用 shell 命令翻文件，最后报"当前环境未授权使用 XXX"。

要的是 `--approve-for-me`（自动审批 + workspace-write 沙箱）。

**也不需要 `--dangerously-bypass-approvals-and-sandbox`** ——
你的写入走 MCP server 那个**独立进程**，不受 CLI 沙箱约束，没必要为此关掉它的沙箱。

### 5.7 Codex 的 `-c` 注入必须是分开的 dotted path ⭐ 静默失效

```bash
# ✅ 有效
-c mcp_servers.x.command="node" -c 'mcp_servers.x.args=["/path/server.js"]'

# ❌ 被静默忽略 —— 跑起来一切正常，只是那台 server 根本不在
-c 'mcp_servers.x={command="node",args=["/path/server.js"]}'
```

症状：模型回一句"没有可用的 XXX 工具"，而你以为自己注入成功了。
**跑之前先 `codex ... mcp list` 验一下。**

### 5.8 Cursor 的工具调用在独立事件里

不在 `assistant` 的 content 里，而是独立的 `tool_call/started` 与 `tool_call/completed`。
MCP 调用的参数在 `tool_call.mcpToolCall.args`。

**内置工具的 `tool_call` 是空对象 `{}`** —— 不判这个会往工具行里塞一堆空条目。

### 5.9 往用户目录写配置：必须合并，而且要说一声

Cursor / opencode 要在工作目录落 MCP 配置。两条铁律：

1. **合并，不是整份替换** —— 用户可能已经配了别的 MCP server，覆盖等于替他删掉
2. **解析不了那个文件就别动它**，宁可这一轮跑不起来
3. 写了要**在界面上说一声**动了哪个文件 —— 悄悄写文件是最招人烦的那种"贴心"

### 5.10 用量读数会骗人

**cache token 是包含在总数里的，而且按 10% 计价。**

【实测】Claude Code 一轮：`input 10 · cache creation 21831 · cache read 118000`，
折算 $0.072。如果把三者加总报 139915，看着像烧了十几万 token 的钱，
**实际主要是缓存命中，虚高一个量级**。

- Claude Code：`input_tokens + cache_creation_input_tokens`，**不加** `cache_read_input_tokens`
- Codex：`input_tokens - cached_input_tokens`（它的 cached 是**含在** input 里的）
- 要权威金额就看 Claude Code 的 `total_cost_usd`

---

## 六、怎么证明真通了

### 6.1 仪器要能说话

这类通道是**黑盒**（子进程 + 它自带的 agent 循环）。出问题时
"解析不出来"和"它真没说"长得一模一样。**留一个原始事件流落盘的后门**：

```python
if os.environ.get("MY_CLI_LOG"):
    with open(os.environ["MY_CLI_LOG"], "a", encoding="utf-8") as f:
        f.write(f"\n===== {datetime.now().isoformat()} {cli} exit={rc} =====\n{stdout}\n"
                f"--- stderr ---\n{stderr}\n")
```

我们那一轮有两个 bug（`--brief` 让回答变空、`json` 模式拿不到工具调用）
**就是靠这个后门分开的** —— 没有它只能猜。

### 6.2 判据要硬

别用"看起来像成功了"。A 类和 B 类各有一条硬判据：

- **A 类**：让它回一个你指定的字符串，精确比对
- **B 类**：让它**真改一个文件**，然后用代码读回来比对内容

【实测】我们的 B 类判据：给一份 `.md`，让 AI 把里面的"蓝"改成"绿"、
`14px` 改成 `16px`，跑完直接读文件确认两处都对，并检查工具调用列表里有
`read_file → write_file`。改对了 ✓、工具链对了 ✓，才算通。

### 6.3 别拿真 AI 回合当回归

每跑一次都花钱（或消耗订阅配额）。回归测试用打桩的假 provider，
真 CLI 只在**验收**时跑。

【实测警告】一天之内 46 个 AI 回合就烧掉了 10 元 —— agent 循环每一步都要重发
"工具表 + 系统提示 + 全部历史"，一轮八步等于把上下文发八次。

---

## 七、给用户的话要说清楚

- **不额外花钱 ≠ 免费**：本地 CLI 走用户自己的订阅，会和他手边正在跑的开发会话
  **抢同一份配额窗口**。这点要在界面上说。
- **模型名让它留空**：空 = 用那个 CLI 自己的默认。硬要用户填反而容易填错 ——
  【实测】按 `--help` 填了 `sonnet-4` 被 cursor-agent 顶回来：
  `Cannot use this model. Available models: auto, composer-2.5, …`。
  **可用模型是按账号来的，写死在文档里一定过时。**
- **能问就问**：`cursor-agent --list-models`（实测列出 31 个）、`opencode models`。
  问不出来就老实说"没有清单，请手填" —— **列不出来不是错误**。
  解析时要剥两种脏东西：ANSI 光标控制符、和它显示名里真的塞着的零宽字符（`​`）。
- **登录要用户自己在终端做一次**：`claude` / `codex login` / `cursor-agent login`。
  你的程序不该替他登录。

---

## 七之二、这份文档里的代码**跑过**

`doc/_samples/` 放着三家 CLI 的**真实事件流样本**和一个验证脚本：

```
doc/_samples/
  claude.jsonl        Claude Code 的 stream-json（改一份 .md）
  codex.jsonl         Codex CLI 的 --json
  cursor-agent.jsonl  Cursor CLI 的 stream-json
  verify.py           把 §二 和 §4.4 的代码抠出来，拿上面三份样本跑一遍
```

```bash
python3 doc/_samples/verify.py
```

【实测读数】

```
cursor-agent  read_file → write_file                     usage None（它确实不报，没编 0）
codex         get_project → read_file → write_file        input 34326（已扣掉缓存命中）
claude        write_file                                  $0.0722 · input 10715
```

**把样本一起留下的理由**：这些 CLI 还在快速迭代，事件形状随时可能变。
哪天解析不出来了，先跑一遍 `verify.py` —— 它过不了就说明是格式变了，
过得了就说明问题在你自己的代码里。**这比重新猜一遍快得多。**

---

## 八、一句提醒

**"这家接不进来"和"这家的 API 接不进来"是两件事。**

我们一开始查 Cursor，结论是"接不进来"——它的 Cloud Agent API 没有 `/chat/completions`
也没有 `/v1/messages`（实测都 404）。但那只说明**它的 API** 不是推理接口，
**它的 CLI 完全可以用**，而且走订阅。

下结论前先把两条路都走一遍。
