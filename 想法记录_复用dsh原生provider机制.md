# 想法记录：让 Dify 运行时复用 dsh 原生的 provider / 模型 / 订阅机制

> 记录时间：2026-10-17　状态：**讨论阶段，未做任何代码改动**

## 一、你的原话要点

> 「还是借助 dsh 的这个模型机制以及订阅管理等……dsh 原生自带了这些信息，provider 就调用这些接口来实现」

即：Dify 工作流的 LLM 节点**不要再自己读 `ZAI_API_KEY` 打裸 HTTP**，而是通过 dsh 宿主的原生服务去解析 provider、模型、凭据与订阅额度。

---

## 二、为什么会有这个想法（现状的问题）

主插件 `dsh-dify-runtime` 当前的 LLM 路径：

```
Dify llm 节点
  → nodes.py
  → llm.py::LlmClient.chat()
  → urllib 裸 HTTP POST 到 https://api.z.ai/api/paas/v4
  → key 从 env / ~/.dsh/.credentials.yaml 手工读
```

`lib/index.js::fillLlmKey()` 只是把 key 塞进 Python 子进程 env。

对应的问题（README 自陈第 1 条）：

- key 明文进子进程 env，`/proc/<pid>/environ` 可读
- 绕过宿主凭据边界：插件自己解析 credentials 文件
- 自写 3 次重试 + 退避，与 `dsh-llm-retry` 策略不一致且互不感知
- 无流式（`"stream": False` 写死），用户看不到逐字输出
- 无 `signal` 取消，只能等 `timeout=120s`
- usage 不进宿主 session 统计，成本归因断开
- provider 路由写死，`DEFAULT_MODEL_MAP` 把所有 provider 压成 `glm-4.5-air`

---

## 三、已核实：dsh 0.2.0-rc.2 原生确实提供了这些

不是空想，代码里都在：

| 机制 | 包 | 关键接口 |
|---|---|---|
| **LLM 服务** | `@deepseek-ai/dsh-llm` | `ctx.llm.stream(GenerateOptions)` → `AsyncIterable<StreamChunk>` |
| provider 路由发现 | 同上 | `listProviders(): LlmProviderInfo[]`、`listModels(provider)` |
| 插件注册新 provider | 同上 | `registerAdapter(providers, adapter)`、`registerConfigurableProviders()` |
| 调用拦截 | 同上 | `llm/stream` waterfall 事件（retry / 路由 / 重放 / 审计） |
| 稳定错误分类 | 同上 | `LlmError` 的 `AUTH` / `RATE_LIMIT` / `NO_ADAPTER` |
| **凭据** | `@deepseek-ai/dsh-credentials` | `ctx.credentials.resolve(ref) → {value, source}` |
| **默认模型** | `@deepseek-ai/dsh-agent-default-model` | `ctx.agentDefaultModel.currentSelection() → {provider, model, reasoningEffort}` |
| **订阅 / 账号型 provider** | `dsh-llm-deepseek-account`、`dsh-deepseek-account`、`dsh-deepseek-account-platform`、`dsh-api-account-controller`、`dsh-authorization` | 订阅型 provider 以 adapter 形式存在，走账号而非 api key |

`GenerateOptions` 关键字段：`provider`、`model`、`messages`、`system`、`temperature`、`maxTokens`、`tools`、`signal`、`sessionId`。

---

## 四、关键发现：姊妹方案 `dsh-dify-native` 已经实现了这条路

`<repo>/dsh-dify-native/lib/provider.js`：

```js
// 路由选择优先级
function resolveRoute(ctx, spec, env) {
  // 1. 插件显式配置的 route
  // 2. DSL 里声明的 provider（若该 provider 在本部署可用）
  // 3. profile 默认模型 agentDefaultModel.currentSelection()
  // 4. dsl-unverified 兜底
}

// LLM 调用
async function streamLlm(ctx, request, route, {...}) {
  for await (const chunk of ctx.get('llm').stream(options)) {
    // 累积 text-delta / reasoning-delta / usage / finish
  }
}
```

同时它还用 `ctx.sandbox.confine`（landlock）包 code 节点、`ctx.workflowEngine` 跑编排、`ctx.subagents` 的 `dify-node` provider 做节点分派。

它的 `services` 工具会探测并列出：`llmProviders`、`llmModels`、`defaultModel`、sandbox、workflowEngine、web、tools。

> **结论：你设想的方案，在 native 版本里已是既成事实；主插件 `dsh-dify-runtime` 才是那个没接的。**

---

## 五、硬障碍：Python 子进程拿不到 JS 侧服务

主插件刻意把 runtime 做成独立 Python 进程（为了「CLI 可独立调试」）。`ctx.llm` 是 JS 侧 Cordis 服务，Python 进程**无法直接访问**。

两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| **(a) 建桥** | JS↔Python stdio JSON-RPC，LLM 调用回转给宿主 | 保留 CLI 独立调试；需自己维护一套协议，调试链路变长 |
| **(b) 迁移** | LLM 节点提到 JS 侧执行 | runtime 裂成两半：图调度在 Python、LLM 在 JS，CLI 路径复杂化 |

---

## 六、待讨论的可行性问题

1. **主插件该向 native 方案靠拢/合并，还是两条线各自保留定位？**
   native 已接全（llm/sandbox/workflowEngine/subagents），但能力面窄（只接线性 `start → code* → end`）；主插件能力面宽（if-else 双分支、aggregator、template 都跑通了），但没接宿主服务。
2. **若保留 Python runtime**，桥的成本 vs 直接迁到 JS 的收益如何权衡？
3. **「订阅管理」具体指哪一层？**
   - 仅复用 provider 路由 + 凭据（最小）
   - 还是要走账号型/订阅型 adapter（`deepseek-account`），让 Dify 工作流也吃订阅额度（更彻底）
4. **DSL 的 `provider/model` 与宿主 route 不一致时的降级策略**
   现在 `DEFAULT_MODEL_MAP` 是**静默压平**；native 的 `resolveRoute` 会按优先级挑并在 `dsl-unverified` 时标注来源。
   这块和上一轮讨论的 `dependencies` / `requiredProviders` 检测**是同一件事**，应该一起设计。

---

## 七、附：相关的上一轮结论（背景）

- Dify DSL 的 `dependencies` 字段是**插件/provider 依赖清单**，官方导入时会解析；老版本 DSL（≤0.1.5）则从 graph 反推。
- 本项目 18 个 DSL 全是 `version: 0.1.0`，全部落在「需反推」那一档，而当前 runtime **完全没解析**。
- 涉及的 provider 至少五种：`deepseek` / `tongyi` / `openai_api_compatible` / `zai` / `builtin`。
