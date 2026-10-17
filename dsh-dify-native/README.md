# dsh-dify-native

在 **dsh harness 自己的能力上**执行真实的 Dify 工作流 `.yml`。

不写调度器，不写执行器，不写沙箱，不写 LLM 客户端。这个包只做一件事：
把 Dify 的 DSL 翻译成一段编排脚本，然后让 harness 已经装好的那几个服务去跑它。

```
Dify .yml
  └─ lib/dsl.js ──────────── 解析 workflow.graph → IR → 编译成编排 JS 脚本
        │
        ├─ ctx.workflowEngine ─ 现成的 dsh 编排循环（部署版：PtcWorkflowEngine）
        │     └─ agent(prompt, opts) ─┐
        ├─ ctx.subagents ─────────────┴─ 注册为 `dify-node`，按节点 kind 分派
        ├─ ctx.llm.stream ──────────── LLM 节点走宿主 provider 路由 / 凭据 / 订阅
        ├─ ctx.sandbox.confine ─────── code 节点走 landlock / bwrap 隔离
        └─ ctx.tools.execute ───────── tool 节点走宿主工具白名单
```

`lib/` 不 import 任何 `@deepseek-ai/*` 运行期类，全部从注入的 Cordis 上下文里取。
**dsh 源码零改动。**

第三方依赖两个：

| 依赖 | 用途 |
| --- | --- |
| `yaml` | 解析 Dify `.yml`（dsh 部署本身已带） |
| `nunjucks` | `template-transform` 的 Jinja2 渲染（Jinja2 的 JS 移植） |

`nunjucks` 装在**插件自己的 `node_modules/`** 里，不装进 dsh 安装目录。插件通过
`link:` 挂进 profile 时，Node 会向上找到插件目录的 `node_modules`，所以无需额外配置。


---

## 为什么是这个形状

有两个被引擎接口逼出来的设计决定，它们解释了这个包为什么长成这样。

### 1. 节点分派只能发生在 subagent provider 上

工作流引擎交给脚本的宿主钩子只有一个：`agent(prompt, opts)`。
`opts.provider` 指的是 **LLM 路由**，不是 subagent provider——subagent provider 在
整轮 run 里是固定的。

所以做不到「每个节点换一个 provider」，只能整轮挂一个 `dify-node` provider，
由它在每次 `agent()` 调用时收到一份 JSON 节点请求，按里面的 `kind` 分派。

这不是取巧，这是在不改 dsh 源码的前提下**唯一**的非侵入位置。

### 2. 分支是代码，不是运行期调度器

`if-else` / `question-classifier` / `http-request` / `human-input` 的出边 handle 是
**预声明的分支名**。编译器把它们翻译成普通的 `if` 块，并给每个节点一个激活守卫：

```js
if ((__ran["s"] === true)) { /* 入口节点 */ }
if ((__ran["br"] === true && __branch["br"] === "true")) { /* true 分支 */ }
```

没被激活的节点不执行，它的结果变量保持 `undefined`。于是**汇合点不需要任何运行期
调度逻辑**——直接读变量就行。模型只负责回答问题，从不决定走哪条边。

---

## 四个工具

插件往 profile 里注册这四个工具：

| 工具 | 作用 |
| --- | --- |
| `dify_native_inspect` | 解析 + 预览编译，列出支持级别和被丢弃的字段。不执行任何东西。 |
| `dify_native_services` | 报告当前 profile 暴露了哪些能力：engine / sandbox / subagent providers / LLM providers / models / 默认模型 / 工具。 |
| `dify_native_sandbox_probe` | 在**活的 harness 里**证明沙箱真的生效：workspace-write 能写、read-only 被拒。 |
| `dify_native_run` | 编译并执行，返回工作流最终 `outputs` 加逐节点记录。 |

`dify_native_run` 的入参：

```jsonc
{
  "path": "/abs/path/to/workflow.yml",   // 必填
  "inputs": { "llm_string": "{...}" },   // start 节点声明的变量
  "timeout": 120,                        // 单个 code 节点的超时秒数
  "tracePath": "/path/to/record.json"    // 可选：把完整运行记录落盘
}
```

---

## 节点支持

解析层是**完整覆盖**的：Dify 前端的 31 个 `BlockEnum` 加上 3 个别名，全部能识别、
能归一化成 IR kind。没有一个会掉到 `generic`——包括未来版本里出现的新类型，
也会被解析出来并明确标记，而不是"我不认识这个节点"。

执行层按节点逐级实现，并且**如实标注每一级的成色**（见下一节）。

### 完整语义

`start` · `end` · `answer` · `if-else` · `code` · `template-transform` ·
`variable-aggregator` · `assigner` · `list-operator` · `iteration` · `loop` ·
`question-classifier` · `http-request` · `trigger*` · `parameter-extractor`

几个值得单独说的：

- **`iteration` / `loop`** 编译成普通 `for` / `while`，`is_parallel: true` 时用引擎的
  `parallel` 组合子。循环次数和元素顺序是代码，不是模型。
- **`code`** 支持 `python3` 和 `javascript`。Python 走 trampoline：注入 Dify 的
  `main(**inputs)` 约定，执行后序列化 JSON 回传。**只在 `ctx.sandbox.confine` 里跑**，
  拿不到沙箱就拒绝执行，绝不在无隔离的情况下跑用户代码。
- **`template-transform`** 支持完整的两层变量语法，语义与 Dify 一致：
  1. `{{#node.var#}}` —— Dify 的 selector 引用，由编译器**在渲染前**替换成值；
  2. 其余部分交给 **Jinja2** 渲染（经 nunjucks），所以 `{% for %}`、`{% if %}`、
     `{% set %}`、嵌套循环、过滤器（`upper` / `round` / `join` / `default` / `sort` /
     `map` / `sum(attribute="x")` / `tojson` / `unique` …）都能用。

  只含 `{{#...#}}` 的模板仍然**零 agent 调用**、在脚本里直接拼接（快路径）；
  含 Jinja 的模板走一次 provider 调用（nunjucks 在 JS 侧）。

  **模板写错了就报错**：语法错误在 `dify_native_inspect` 阶段就能看到，
  执行时该节点直接失败并给出出错行，绝不把原始模板文本当结果返回。
- **`variable-aggregator`** 编译成普通 JS（取第一个非空分支值），零 agent 调用。

### 部分语义（`simplified`）

这些节点能跑，但只实现了 Dify 的一部分语义，**而且会明确告诉你缺了什么**：

| 节点 | 现状 | 缺口 |
| --- | --- | --- |
| `knowledge-retrieval` | 在本地数据集目录上做词法 grep（含 CJK bigram） | **不是向量检索**，没有 embedding |
| `tool` | 经 `ctx.tools.execute` 分派到宿主工具，白名单管控 | 只覆盖宿主已注册的工具 |
| `agent` | 单次模型回合 | **声明的 tools 不执行** |
| `document-extractor` | 文本类文件 | **无 PDF / Office 解析** |
| `datasource` | 本地 JSON / JSONL / 文本文件 | 不是 Dify datasource 插件 |
| `human-input` | 从运行参数或首个声明动作确定性解析 | **不支持暂停/恢复** |

### 占位（`placeholder`）

- `knowledge-index` —— 没有挂载向量库，什么都不写，但会出现在记录里。

---

## 诊断：不静默丢东西

这是这个包最重要的行为约定。

运行时会按节点逐个补齐，所以一张图里**完全可能**有节点只实现了子集语义。这是允许的。
**不允许的是把这个事实藏起来。**

`lib/diagnostics.js` 把每一处「跳过了节点、丢了 DSL 字段、用了简化实现」都记成一条诊断，
而不是抛错：

```
field-dropped          DSL 里设了值，但本运行时不读这个字段，值被忽略
node-simplified        节点只实现了 Dify 语义的子集
node-placeholder       节点被调度了，但不做该节点的实际工作
node-unknown           未知节点类型，作为可见的 passthrough 执行
template-jinja-invalid 模板写错了（Jinja2 编译失败），执行到该节点时会失败
note                   编译器自己的结构性提示
```

诊断**从不改变行为**：带诊断的图照样执行，照样报 `succeeded`。它们只对工程师可见——
出现在 `inspect` 输出、`run` 的逐节点记录、以及 `tracePath` 落盘的记录里。

例外是 `template-jinja-invalid`：它报告的模板错误在执行时**会**让那个节点失败
（而且是模板作者的错，不替他兜底）。之所以仍在编译期报出来，是为了让 `inspect`
在你花掉模型调用之前就告诉你——而不是等一张图跑了一半才炸。

每个节点还带一个支持级别：`full`（默认，省略）/ `simplified` / `placeholder` / `passthrough`。
节点显式声明某个字段却没被实现，会自动降级成 `simplified`，理由写 `some declared fields were dropped`。

被丢弃字段的扫描会跳过纯展示字段（`position`、`width`、`internals` 等 Canvas 元数据），
也会放过「值本来就等于默认值」的模型参数（`top_p: 1`、零 penalty），
免得把它们埋在真正的缺口里。

---

## LLM 路由

DSL 里的 `model.provider` / `model.name` 是一个**请求**，不是命令。
provider 会挑一条当前 profile 真的能服务的路由，顺序如下：

1. `DIFY_LLM_PROVIDER` + `DIFY_LLM_MODEL`（显式配置，且该 provider 已注册）
2. DSL 声明的 provider（且该 provider 已注册）
3. profile 默认模型（`agentDefaultModel.currentSelection()`）
4. 以上都不成立时，退回 DSL 声明并标记 `dsl-unverified`

每个 LLM 节点的记录都带 `meta.provider` / `meta.model` / `meta.requested` / `meta.routeSource`，
所以「DSL 要求 deepseek，实际跑在 glm 上」这件事永远是可追溯的，不会静默压平。

`ctx.llm.stream` 带来的东西：宿主的凭据边界、`dsh-llm-retry` 策略、取消信号、
usage 统计进宿主 session。这些都不需要这个包自己实现。

---

## 会话记忆与系统变量

Dify 的 `memory`（`TokenBufferMemory`）和 `sys.*` 系统变量，直接映射到 harness 的
session log，不引入自己的会话存储。

**`memory`** —— `session.deriveMessages()` 的结果转成 Dify 的形状，过两道滤网：

1. 只有 `source.kind === 'user'` 的消息才算用户轮次。循环还会追加协议注入的 user
   消息（指令、运行时快照、catalog），那些不是用户在说话。
2. 带 tool-call 的 assistant 消息是 agent 的工作过程，不是回答，跳过。

然后按 `memory.window.size` 裁窗口（Dify 语义：最近 N **条**消息，不是 N 对），
按 `role_prefix` 渲染（默认 `Human:` / `Assistant:`）。

**`sys.*`** —— 编译进脚本的 `__vars.sys`，从 `args['sys.*']` 读：

- `sys.conversation_id` ← 调用方 harness session 的 id
- `sys.dialogue_count` ← 真实用户轮次数（用同一套滤网，和 memory 保持一致）

刻意**不**从会话里臆造 `sys.query` / `sys.files`：一轮 run 的当前输入是调用方传的
`inputs`，不是"agent 上次说的话"，猜就是错。没有活会话时（离线一次性调用）
这些变量保持 Dify 默认值，脚本照常执行。

---

## 安全边界

- **code 节点**：`ctx.sandbox.confine` 隔离。没有沙箱就返回错误，不降级裸跑。
- **tool 节点**：白名单先于调用。默认 `web_search,web_fetch`，未列出的工具在
  dispatch 之前就被拒。`DIFY_TOOL_ALLOW=*` 表示全放开。
- **document-extractor**：本地文件路径必须解析在 workspace 或 `DIFY_DOCUMENT_ROOT` 之内，
  越界直接拒绝；同时支持 `ctx.web.fetch` 拉远程 URL 的文本。
- **knowledge-retrieval**：`dataset_ids` 按 `DIFY_KNOWLEDGE_ROOT` 解析成本地目录，
  找不到就报错并列缺失的 id（不会静默返回空结果）。注意：写成绝对路径的 id 会原样使用。
- **http-request**：纯 GET 走 `ctx.web.fetch`；其余走沙箱 + `curl`。

### ⚠️ 已知限制：模板里的属性访问可以穿透到 JS 宿主

**这是一个已登记、尚未处理的已知问题。**

`template-transform` 的模板在 JS 侧由 nunjucks 渲染，而 nunjucks **不是沙箱**：
模板里的属性访问可以沿着 JS 原型链走到宿主运行时。例如

```jinja
{{ a["constructor"]["constructor"]("return process")() }}
```

在当前 Node ESM 环境里，这样能把 `process` 对象取出来。更进一步的利用
（`process.mainModule.require` 读文件）目前被 ESM 环境挡住——但这是**环境巧合，
不是设计保证**。

当前状态：

- `lib/jinja.js` 已经拦截了 `constructor` / `__proto__` / `prototype` 等一组危险属性名
  （挂在 nunjucks 的 `runtime.memberLookup` 上），实测上面这行会被挡住、正常属性访问不受影响；
- 但这是一层**缓解**，不是完整的沙箱。模板仍然能调用上下文里传入的函数。

因此：**只运行可信来源的工作流如 `.yml`**。不要让不可信用户提交的模板直接跑。
真要彻底解决，需要把模板渲染放进 `ctx.sandbox` 隔离的子进程，那是另一项工作。


---

## 安装

作为 dsh bundle 挂进 profile。`package.json` 里声明了 patch：

```jsonc
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-dify-native
      name: 'dsh-dify-native'
```

然后在 profile 的 `dsh.profile.bundles` 里加上 `dsh-dify-native`。开发时用 link：

```jsonc
// ~/.dsh/profiles/<name>/package.json
"dependencies": { "dsh-dify-native": "link:/path/to/dsh-dify-native" }
```

改代码即刻生效，不需要重新打包。

### 环境变量

全部可选：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DIFY_LLM_PROVIDER` + `DIFY_LLM_MODEL` | — | 强制 LLM 路由，**两个都要设才生效** |
| `DIFY_TOOL_ALLOW` | `web_search,web_fetch` | tool 节点白名单，逗号分隔；`*` 全放开 |
| `DIFY_KNOWLEDGE_ROOT` | `<workspace>/knowledge` | knowledge-retrieval 的数据集根目录 |
| `DIFY_DOCUMENT_ROOT` | `<workspace>` | document-extractor 的文件根目录 |
| `DIFY_RUNTIME_PYTHON` | `python3` | 执行 code 节点的解释器 |
| `DIFY_PYTHONPATH` | 自动探测 | Python 的 `PYTHONPATH` |
| `DSH_DIFY_RUNTIME_ROOT` | `../dsh-dify-runtime/runtime` | 找 vendored Python 库的根 |

---

## 测试

全部离线，不需要 harness、不需要网络、不需要模型调用：

```sh
cd dsh-dify-native
./tests/run-all.sh        # → ALL TESTS OK
```

九个文件，覆盖：

| 文件 | 覆盖 |
| --- | --- |
| `dsl.test.mjs` | 解析、IR、编译、拒绝不合法的图 |
| `nodes.test.mjs` | 节点执行语义 |
| `nodes-new.test.mjs` | 后补节点（agent / datasource / document / list-operator / trigger …） |
| `coverage.test.mjs` | 31 个 `BlockEnum` 全覆盖；18 个真实 DSL 样本零未知类型、全部可编译 |
| `diagnostics.test.mjs` | 诊断只在真缺口时出现，且从不升级成编译错误 |
| `session-memory.test.mjs` | 记忆滤网、窗口、role_prefix |
| `sys-vars.test.mjs` | 系统变量来自 args，无会话时保持默认 |
| `provider.test.mjs` | classifier / http-request / tool 白名单 / knowledge-retrieval |
| `translation-script.test.mjs` | 分支编译成普通 `if`，两条路径都正确 |

`coverage.test.mjs` 会扫描仓库里的 `../dsl/*.yml` 真实样本。当前 18 个样本
**全部零 issue、零未知类型**，其中 12 个是全语义实现。

---

## 目录

| 文件 | 职责 | 行数 |
| --- | --- | --- |
| `lib/dsl.js` | 解析 Dify DSL → IR → 编译编排脚本。校验图结构、拓扑排序、分支守卫。 | ~1800 |
| `lib/provider.js` | `dify-node` provider：按 kind 分派节点，每个节点一个 capability 实现。 | ~1545 |
| `lib/index.js` | Cordis 插件：注册 provider + 四个工具，渲染 inspect/run 输出。 | ~510 |
| `lib/jinja.js` | `template-transform` 的 Jinja2 渲染（nunjucks + 过滤器补齐 + 属性访问防护）。 | ~235 |
| `lib/session-history.js` | Dify memory ↔ harness session log 的适配层。 | ~130 |
| `lib/diagnostics.js` | 诊断收集器 + 字段丢弃扫描。无依赖、无副作用。 | ~135 |

`dsl.js` 和 `provider.js` 都是纯翻译层 / 能力层——它们不调度、不隔离、不连模型。

---

## 边界

- **不支持非交互暂停**。`human-input` 是确定性解析的，不会真的等人。
- **没有向量检索**。`knowledge-retrieval` 是词法匹配，`knowledge-index` 是空操作。
- **触发节点只是入口**。`trigger*` 可以作为图的起始节点被解析和编译，但这个包
  不监听 webhook、不跑 cron、不订阅事件——什么时候跑由调用方决定。
- **没有 PDF / Office 解析**。
- **单轮，无 chat 状态机**。`answer` 节点会累积到 `answers`，多轮对话语义由
  调用方的会话承担。
- **Jinja2 不是 100% 兼容**。渲染器是 nunjucks（Jinja2 的 JS 移植），少数边角行为
  与 Python Jinja2 有差异。缺失的常用过滤器（`map` / `tojson` / `items` / `unique`）
  已在 `lib/jinja.js` 里补上；`sum(attribute="x")` 的关键字参数形式也重写过了——
  原版 nunjucks 对这种写法**静默返回 `NaN`**，那正是本运行时拒绝产生的那种错误。
  模板用了 nunjucks 也不认识的构造时，节点会失败并说明原因，而不是输出错的文本。
- **模板里的属性访问未完全沙箱化**。见上面「安全边界」里的已知限制。
