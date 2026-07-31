# native_oai_config5 的 Codex 请求兼容建议

> 日期：2026-07-31  
> 状态：仅分析与方案，尚未修改 `mykey.py` 或 `llmcore.py`  
> 依据：真实 Codex 0.144.5 抓包、`mykey.py` 当前配置、`llmcore.py` 请求实现

---

## 1. 结论

`native_oai_config5` 当前返回 403 的**首要问题是 API 模式和端点不匹配**，而不是仅仅少了几个 Codex 请求头。

当前配置明确为：

```python
'native_oai_config5': {
    'apibase': 'https://api.zzzcoding.org/v1',
    'model': 'gpt-5.6-sol',
    'api_mode': 'chat_completions',
}
```

因此 GA 实际发送：

```text
POST /v1/chat/completions
```

但同一站点、同一模型下，真实 Codex 0.144.5 成功请求发送的是：

```text
POST /v1/responses
```

GA 当前形成了一个混合请求：

- URL/body 使用普通 Chat Completions 协议；
- 同时无条件携带 `originator: codex_exec`；
- User-Agent 又伪装成旧版 `codex_exec/0.139.0`。

即“Codex 身份 + 非 Codex 请求协议”。如果中转站限制该账号只能经 Codex 官方客户端使用，这种请求很容易被识别并拒绝。

因此，建议的第一步不是直接大改请求头，而是先把 config5 从 `chat_completions` 切到 `responses`，让端点与基础协议先对齐。是否仅这一项就能消除 403，当前尚未实测，不能提前断言。

---

## 2. 已核实的调用链

### 2.1 config5 确实走 Chat Completions

`mykey.py` 中 config5 的 `api_mode` 是 `chat_completions`。

`llmcore.py:584-585` 将配置解析为：

```python
self.api_mode = 'responses' if mode in ('responses', 'response') else 'chat_completions'
```

`llmcore.py:434-450` 决定请求端点：

- `api_mode == "responses"` → `/v1/responses`；
- 其他模式 → `/v1/chat/completions`。

因此 config5 的 403 请求并未进入 GA 的 Responses payload 分支。

### 2.2 config5 确实使用 NativeOAISession

`llmcore.py:1138` 根据配置变量名选择 Session：

- 名字含 `native` 且含 `claude` → `NativeClaudeSession`；
- 名字含 `native`、不含 `claude` → `NativeOAISession`。

所以 `native_oai_config5` 会使用 `NativeOAISession`。

### 2.3 GA 当前的 Codex 身份头

`llmcore.py:432-433` 对 OpenAI 请求无条件设置：

```text
originator: codex_exec
User-Agent: <session user_agent>
```

config5 没有自行配置 `user_agent`，因此 `NativeOAISession` 使用源码中的默认值：

```text
codex_exec/0.139.0 (Windows 10.0.26200; x86_64) unknown (codex_exec; 0.139.0)
```

这与本机真实 Codex 0.144.5 的 User-Agent 不同。

---

## 3. 真实 Codex 0.144.5 的请求特征

抓包得到的请求行为为：

```text
POST /v1/responses HTTP/1.1
```

主要请求头：

```text
x-codex-beta-features: remote_compaction_v2
x-codex-window-id: <session_id>:0
x-codex-turn-metadata: <JSON>
x-openai-internal-codex-responses-lite: true
x-client-request-id: <session_id>
session-id: <session_id>
thread-id: <session_id>
accept: text/event-stream
content-type: application/json
originator: codex_exec
user-agent: codex_exec/0.144.5 (Windows 10.0.19045; x86_64) vscode/1.121.03429 (codex_exec; 0.144.5)
```

其中 `x-codex-turn-metadata` 包含：

```text
installation_id, session_id, thread_id, turn_id, window_id,
request_kind, thread_source, sandbox, workspaces,
turn_started_at_unix_ms
```

真实 body 的关键字段：

```json
{
  "model": "gpt-5.6-sol",
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": {"effort": "medium", "context": "all_turns"},
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<session_id>",
  "text": {"verbosity": "low"},
  "client_metadata": {}
}
```

抓到的 `client_metadata` 实际有 6 个键：

```text
thread_id, x-codex-window-id, session_id,
x-codex-turn-metadata, turn_id, x-codex-installation-id
```

真实请求没有使用顶层 `instructions` 和顶层 `tools`。系统/开发者提示位于 `input` 的 developer 消息中；工具被包装成 `input[0]` 的 `additional_tools` 项。本次样本中有 `exec`、`wait`、`request_user_input`、`collaboration` 四个工具。
---

## 4. 差异概览：GA vs 真 Codex 0.144.5

将 GA 的 Responses 分支（`llmcore.py:432-441`）与抓包结果逐项对比：

| 比较项 | 真 Codex 0.144.5 | GA Responses 分支现状 |
|---|:---|:---:|
| **端点** | `POST /v1/responses` | 正确（但 config5 实际没走这里） |
| **`x-codex-beta-features`** | `remote_compaction_v2` | 缺失 |
| **`x-codex-window-id`** | `<session_id>:0` | 缺失 |
| **`x-codex-turn-metadata`** | 完整 JSON（9 个字段） | 缺失 |
| **`x-openai-internal-codex-responses-lite`** | `true` | 缺失 |
| **`x-client-request-id`** | `<session_id>` | 缺失 |
| **`session-id` / `thread-id`** | 有，三者同值 | 缺失 |
| **`User-Agent`** | `codex_exec/0.144.5 ... vscode/1.121.03429` | `0.139.0 ... unknown`（旧版，无 `vscode/` 后缀） |
| **`originator`** | `codex_exec` | 已有 |
| **`body.store`** | `false` | 缺失 |
| **`body.text.verbosity`** | `"low"` | 缺失 |
| **`body.tool_choice`** | `"auto"` | 缺失（GA 默认 `none`） |
| **`body.parallel_tool_calls`** | `false` | 缺失 |
| **`body.reasoning.context`** | `"all_turns"` | 缺失（只有 `effort`） |
| **`body.prompt_cache_key`** | `= session_id` | 进程级随机 UUID |
| **`body.client_metadata`** | 6 个键 | 2 个键，且键名存在错写（`x-codex-installation-id` 这种非标准写法） |
| **body 结构** | 无 `instructions`，无顶层 `tools`；`input[0]` 为 `additional_tools` | 顶层 `instructions` + 顶层 `tools` |
| **ID 格式** | UUIDv7（时间有序，`019fb7be-` 前缀） | UUIDv4 |

---

## 5. 改造方案

分三档，建议按顺序验证，每档完成后用抓包服务器自证，再打真实端点。

### 第一档：只改 config（零代码改动，先排除端点问题）

修改 `mykey.py` 中 `native_oai_config5`：

```python
'native_oai_config5': {
    'api_mode': 'responses',        # 改这里
    'user_agent': 'codex_exec/0.144.5 (Windows 10.0.19045; x86_64) vscode/1.121.03429 (codex_exec; 0.144.5)',
    # 'reasoning_effort': 'medium',  # 取消注释
}
```

**预期效果**：GA 会发送 `POST /v1/responses`，使用标准 Responses payload。是否消除 403，实测可知。

**成本**：改一行配置，零代码风险，随时可回退。

### 第二档：补请求头（改 `llmcore.py`）

在 `_openai_stream` 的 Responses 分支（`llmcore.py:432` 附近），当识别到 codex 伪装模式时，补齐以下请求头：

```python
headers.update({
    "x-codex-beta-features": "remote_compaction_v2",
    "x-codex-window-id": f"{session_id}:0",
    "x-codex-turn-metadata": json.dumps(turn_metadata),
    "x-openai-internal-codex-responses-lite": "true",
    "x-client-request-id": session_id,
    "session-id": session_id,
    "thread-id": session_id,
})
```

同时补齐 body 字段：

```python
payload.update({
    "store": False,
    "text": {"verbosity": "low"},
    "tool_choice": "auto",
    "parallel_tool_calls": False,
    "reasoning": {**payload.get("reasoning", {}), "context": "all_turns"},
    "prompt_cache_key": session_id,
    "client_metadata": {
        "thread_id": session_id,
        "x-codex-window-id": f"{session_id}:0",
        "session_id": session_id,
        "x-codex-turn-metadata": json.dumps(turn_metadata),
        "turn_id": turn_id,
        "x-codex-installation-id": installation_id,
    },
})
```

部分值（`session_id`, `turn_id`, `installation_id`, `turn_metadata`）需要做会话级持久化——当前 GA 的 `_RESP_CACHE_KEY` 是进程级单值，不轮换。

**注意事项**：

- 当前 Python 环境为 3.12.13，`uuid.uuid7()` 尚不可用（3.14+ 才开始支持）。UUIDv7 可手写实现：48 位毫秒时间戳 + 74 位随机位。
- 改动成果应通过 config 开关控制（如 `codex_headers: True`），避免影响其他 Responses 渠道。
- 此项改动后，GA 的请求头将基本对齐真 Codex。

### 第三档：改 body 形状（最大改动，必要时才做）

将 payload 改为 Responses 原生形状：

- 移除顶层 `instructions`，将系统提示合并到 `input` 的 `developer` 消息；
- 移除顶层 `tools`，改为 `input[0]` 的 `additional_tools` 项。

这一档风险最高——它会改变 GA 所有 Responses 渠道的 payload 结构，且 `additional_tools` 是 Codex 内部形状，其他 Responses 端点未必认。建议做成独立 config 开关（如 `codex_mimic: 'full'`），仅对 config5 这类要求 Codex 身份的渠道启用。

---

## 6. 验证方法

抓包服务器 `temp/codex_capture/cap.py` 已就绪，可起本地 Responses 服务，通过 `-c` 覆写 base_url，将真 Codex 的请求完整落盘（`raw.json`，authorization 已脱敏，不读取用户 `~/.codex/config.toml`）。

反过来也能用：改完 GA 后，将 config5 的 `apibase` 临时指向抓包服务器，捕获 GA 发出的报文，与 `raw.json` 做 diff。头和 body 对齐后再打真实端点。这样每档改动都能在不消耗上游配额、不触发风控的前提下先自证。

---

## 7. 需要你判断的两点

1. **要不要做、做到哪一档。** 这套改造本质是让 GA 更完整地冒充 Codex 官方客户端，以绕过中转站的客户端校验，第三档尤其明显。技术可行，但涉及对该中转站服务条款的取舍——这是你的账号和你的决定。

2. **长期是加固伪装还是换渠道。** 即便伪装完全对齐，`gpt-5.3-codex` 的 503 说明上游部分模型确实没池子，伪装解决不了容量问题。config1（`muyuan.do`）已 `model_not_found` 失效。若 config5 也只是临时可用，长期更该换渠道而非持续加固伪装。