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
        ├─ ctx.web.fetch / fetch ───── 声明式工具契约的一次 HTTP 调用
        └─ ctx.tools.execute ───────── 显式 opt-in 的宿主工具 passthrough
```

`lib/` 不 import 任何 `@deepseek-ai/*` 运行期类，全部从注入的 Cordis 上下文里取
。
**dsh 源码零改动。**

第三方依赖三个，都**不装进 dsh 安装目录**：

| 依赖 | 用途 | 来源 |
| --- | --- | --- |
| `yaml` | 解析 Dify `.yml`，以及 `lib/tool-contracts.js` 里的工具契约 YAML | dsh 部署本身已带 |
| `ajv` | LLM 节点 `structured_output` 的 JSON Schema 校验（含一次修复回合） | dsh 运行期自带（`@deepseek-ai/dsh` 的依赖），已在 `lib/provider.js` 里直接 `import` |
| `nunjucks` | `template-transform` 的 Jinja2 渲染（Jinja2 的 JS 移植） | 插件自己声明 |

`nunjucks` 装在**插件自己的 `node_modules/`** 并写进了 `package.json` 的 `dependencies`，
插件通过 `link:` 挂进 profile 时 Node 会向上解析到它，无需额外配置。
`ajv` 由 dsh 安装自带（`@deepseek-ai/dsh` 的依赖），`lib/provider.js` 直接 `import 'ajv'`，
按 Node 的解析规则向上查找 `node_modules`。用 `link:` 挂载时本仓库位于
`/home/walker/dify-test/dsh-dify-native`，**不**在 `<dsh 安装目录>/node_modules` 之下——
这种布局下 `ajv` 能否解析取决于 profile / 安装方式，本仓库没有为此写入 `package.json` 依赖。
把插件单独拷到别处运行前需自行提供 `ajv`。

> 代价：`structured_output` 依赖 dsh 自带的 `ajv`，这是一条未写进本包 `package.json` 的隐式依赖。
> 只有在 `ajv` 确实能被解析到时 `lib/provider.js` 才能加载；解析不到时不是"跳过校验"，
> 而是插件加载即失败（模块解析错误）。


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

### 解析层：覆盖已知的节点类型

`lib/dsl.js` 认识 Dify 前端 `BlockEnum` 里的 **30 个类型**（见 `tests/coverage.test.mjs` 里的
`BLOCK_ENUM` 列表，以该列表为准），再加 3 个导出里出现的别名 / 标记
（`custom-note`、`iteration-end`、`trigger`），全部归一化成 IR kind，没有一个会掉到 `generic`。

**这只是解析层的事实**：它证明"认识"这些类型，不等于"执行语义完整"。而且它只覆盖写死的列表——
Dify **未来版本**新增的节点类型不在里面，会被当作未知类型（`node-unknown` 诊断 + `passthrough` 支持级别），
不会导致整张图失败，但也不会执行该节点的实际工作。

执行层按节点逐级实现，并且**如实标注每一级的成色**（见下一节）。下面的"完整语义"是
**支持级别的标签**——即"没有已知的降级原因"，不是"Dify 的全部语义都由本运行时验证过"。

### 完整语义（`full`）

`start` · `end` · `answer` · `if-else` · `code` · `template-transform` ·
`variable-aggregator` · `assigner` · `list-operator` · `iteration` · `loop` ·
`question-classifier` · `http-request` · `trigger*` · `parameter-extractor`

`full` 是**默认级别**：它意味着"**没有**检测到降级原因"，而不是逐字段对照 Dify 验证过的结论
（一条 `full` 记录可能是"实现了"，也可能只是"没有触发任何已知的降级规则"）：
- 节点声明了运行时未实现的字段，会自动降为 `simplified`（理由 `some declared fields were dropped`）；
- 但没有声明、或运行时根本没扫描到的字段，不会触发降级。

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
- **`variable-aggregator`** 编译成普通 JS，零 agent 调用。

  **选择规则按 Dify 1.9.1 的 `VariableAggregatorNode._run` 实现**：取第一路**存在**的变量
  （未运行的节点 = `undefined`），**只判断存在性，不看内容**。所以第一路分支真的运行了、
  但值为 `null` 或空串（`""`）、`0`、`[]` 时，结果就是那个 `null` / 空值——**不会**继续往后找。
  高级设置开启分组（`advanced_settings.group_enabled`）时按组各自选。

### 部分语义（`simplified`）

这些节点能跑，但只实现了 Dify 的一部分语义，**而且会明确告诉你缺了什么**：

| 节点 | 现状 | 缺口 |
| --- | --- | --- |
| `knowledge-retrieval` | 在本地数据集目录上做词法 grep（含 CJK bigram） | **不是向量检索**，没有 embedding |
| `tool` | 三选一：声明式 YAML 契约（一次 HTTP 请求 + 响应映射）/ 显式 opt-in 的宿主工具 passthrough / 拒绝 | **不支持 `.difypkg` 插件**（需要 plugin daemon）；没有名字猜测表；契约格式与限制见 [docs/dify-tool-contract.md](docs/dify-tool-contract.md) |
| `agent` | 显式 dsh-bounded-tools 有界工具循环；旧单轮路径保留 | 原生策略插件仍 S，见 [替代策略协议](docs/agent-strategy.md) |
| `document-extractor` | 固定官方 PDFium / python-docx / pandas+openpyxl 提取；8 格式逐字差分验证 | 需显式安装轻量依赖；旧 Office/unstructured 链仍有 S 子项，不含 OCR |
| `datasource` / `datasource-empty` | sys 驱动文件/网站信息 + 声明式远端桥；保留显式 local/file records | 原生插件/云账户尚未验证，见 [部署协议](docs/datasource-contract.md) |
| `human-input` | 从运行参数或首个声明动作确定性解析 | **不支持暂停/恢复** |

### 占位（`placeholder`）

- `knowledge-index` —— 没有挂载向量库，什么都不写，但会出现在记录里。

### 未知类型（`passthrough`）

`lib/dsl.js` 的已知类型是写死的列表。列表之外的节点类型（例如 Dify 未来版本新增的类型）
会被标记为 `node-unknown` 诊断、以 `passthrough` 级别执行——也就是说，它**不执行该节点的实际工作**，
只是让图能继续走。支持级别在 `dify_native_inspect` 的 `support` 列表里逐节点给出。

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
- **tool 节点**：白名单先于任何解析。默认 `web_search,web_fetch`（只做精确匹配，没有通配），
  未列出的工具在 dispatch 之前就被拒。`DIFY_TOOL_ALLOW=*` 表示全放开。
  放行之后只有两条真正执行的路：**声明式 YAML 契约**（`DIFY_TOOLS_ROOT` 下的
  provider/tool 契约，一次 HTTP 调用）和**显式 opt-in 的宿主工具**（`DIFY_TOOL_PASSTHROUGH`
  里列出的确切工具名）。没有名字猜测表——`jina_reader` 不会被悄悄换成 `web_fetch`。
  **`.difypkg` 插件形态的工具不支持**（需要 Dify plugin daemon），会明确拒绝。
  契约格式、替换语法和限制见 [docs/dify-tool-contract.md](docs/dify-tool-contract.md)。
  契约会把 `tool_configurations` 当作凭据拼进请求，所以**契约文件与工作流都必须可信**。
- **document-extractor**：本地文件路径必须解析在 workspace 或 `DIFY_DOCUMENT_ROOT` 之内，
  越界直接拒绝；同时支持 `ctx.web.fetch` 拉远程 URL 的文本。
- **knowledge-retrieval**：`dataset_ids` 按 `DIFY_KNOWLEDGE_ROOT` 解析成本地目录，
  找不到就报错并列缺失的 id（不会静默返回空结果）。注意：写成绝对路径的 id 会原样使用。
- **http-request**：纯 GET 走 `ctx.web.fetch`；其余及 `ssl_verify=false` 走沙箱 + `curl`。false 仅对单请求关闭验证；null 明确失败。

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
| `DIFY_TOOL_ALLOW` | `web_search,web_fetch` | tool 节点白名单，逗号分隔，精确匹配；`*` 全放开 |
| `DIFY_TOOLS_ROOT` | —（无契约） | 声明式工具契约的根目录，**冒号分隔**多个目录，递归扫描 `*.yaml` / `*.yml` |
| `DIFY_TOOL_PASSTHROUGH` | —（不放开） | 允许 tool 节点按**确切名字**调用的宿主工具，逗号分隔 |
| `DIFY_KNOWLEDGE_ROOT` | `<workspace>/knowledge` | knowledge-retrieval 的数据集根目录 |
| `DIFY_DOCUMENT_ROOT` | `<workspace>` | document-extractor 的文件根目录 |
| `DIFY_RUNTIME_PYTHON` | `python3` | 执行 code 节点的解释器 |
| `DIFY_PYTHONPATH` | 自动探测 | Python 的 `PYTHONPATH` |
| `DIFY_VENDOR_DIR` | 同 `DIFY_PYTHONPATH` | code 节点 `dependencies` 的安装目录 |
| `DSH_DIFY_RUNTIME_ROOT` | `../dsh-dify-runtime/runtime` | 找 vendored Python 库的根 |

---

## 测试

全部离线，不需要 harness、不需要网络、不需要模型调用：

```sh
cd dsh-dify-native
./tests/run-all.sh        # → ALL TESTS OK
```

这是**单元 / 集成层的离线测试**，证明的是运行时自身的翻译与分派逻辑符合实现意图。
总入口也执行已安装 dsh 的真实工作流引擎测试，LLM 使用固定回复。它不证明与 Dify 官方执行器逐字段一致，
最终能力证据以 [`docs/capability-report.md`](docs/capability-report.md) 为准。

`run-all.sh` 当前跑 18 个文件，覆盖：

| 文件 | 覆盖 |
| --- | --- |
| `dsl.test.mjs` | 解析、IR、编译、拒绝不合法的图 |
| `nodes.test.mjs` | 节点执行语义 |
| `nodes-new.test.mjs` | 后补节点（agent / datasource / document / list-operator / trigger …） |
| `control-semantics.test.mjs` | 控制流语义（分支、守卫、容器） |
| `coverage.test.mjs` | 30 个 `BlockEnum` 类型解析到已知 kind；`../dsl/*.yml` 样本零未知类型、全部可编译 |
| `diagnostics.test.mjs` | 诊断只在真缺口时出现，且从不升级成编译错误 |
| `template-jinja.test.mjs` | 模板替换与 Jinja2 渲染 |
| `session-memory.test.mjs` | 记忆滤网、窗口、role_prefix |
| `sys-vars.test.mjs` | 系统变量来自 args，无会话时保持默认 |
| `code-file-input.test.mjs` | code 节点的文件输入 |
| `provider.test.mjs` | classifier / http-request / tool 白名单 / knowledge-retrieval |
| `tool-contracts.test.mjs` | 声明式工具契约：加载、占位符、空值省略、响应映射、失败路径 |
| `tool-node.test.mjs` | tool 节点分派：契约 → `.difypkg` 拒绝 → passthrough → 拒绝 |
| `structured-output.test.mjs` | structured_output 的 ajv 校验 + 一次修复回合 |
| `translation-script.test.mjs` | 分支编译成普通 `if`，两条路径都正确 |
| `container-scope.test.mjs` | 容器作用域及嵌套回归 |
| `engine-e2e.test.mjs` / `engine-nested.test.mjs` | 真实 dsh 引擎的样本矩阵、分支、失败和嵌套容器 |

测试覆盖的是**已验证的范围**：`coverage.test.mjs` 扫描的 `../dsl/*.yml` 样本、以及各测试里构造的
图。它们不能推出"任意 Dify 工作流都可运行"。

`coverage.test.mjs` 对样本只断言两件事：零未知类型、零解析/调度 issue、能编译成脚本。
它**不**要求所有节点都是 `full` 级别——实际用 `dify_native_inspect` 的 `support` 列表逐节点看，
当前 18 个样本里就有若干节点是 `simplified`（如 `agent`、`datasource`、`document-extractor`、
`list-operator`、`knowledge-retrieval`，以及声明了被丢弃字段的 `llm`）。
`full` 是"没有检测到降级原因"的默认值，不是"Dify 全语义已被验证"的结论。

---

## 目录

| 文件 | 职责 | 行数 |
| --- | --- | --- |
| `lib/dsl.js` | 解析 Dify DSL → IR → 编译编排脚本。校验图结构、拓扑排序、分支守卫。 | ~1880 |
| `lib/provider.js` | `dify-node` provider：按 kind 分派节点，每个节点一个 capability 实现；tool 节点分派根。 | ~1800 |
| `lib/index.js` | Cordis 插件：注册 provider + 四个工具，渲染 inspect/run 输出。 | ~510 |
| `lib/tool-contracts.js` | 声明式工具契约：加载 YAML、替换三种占位符、一次 HTTP 调用、响应映射。 | ~330 |
| `lib/jinja.js` | `template-transform` 的 Jinja2 渲染（nunjucks + 过滤器补齐 + 属性访问防护）。 | ~235 |
| `lib/session-history.js` | Dify memory ↔ harness session log 的适配层。 | ~130 |
| `lib/diagnostics.js` | 诊断收集器 + 字段丢弃扫描。无依赖、无副作用。 | ~135 |

文档：[`docs/dify-tool-contract.md`](docs/dify-tool-contract.md)（工具契约格式与限制）、
[`docs/control-semantics.md`](docs/control-semantics.md)（控制流语义）。

`dsl.js` 和 `provider.js` 都是纯翻译层 / 能力层——它们不调度、不隔离、不连模型。

---

## 边界

- **不支持非交互暂停**。`human-input` 是确定性解析的，不会真的等人。
- **没有向量检索**。`knowledge-retrieval` 是词法匹配，`knowledge-index` 是空操作。
- **触发协议有限**。`trigger*` 支持显式参数注入及 [声明式事件桥](docs/event-deployment.md)；原生插件订阅仍未实现。历史上这个包
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
- **工具只覆盖"一次 HTTP 请求 + 取字段"**。`.difypkg` 插件不支持；需要签名、OAuth、多步调用的工具
  无法用契约表达。契约没有参数类型转换、没有 schema 校验，JSON body 只有一层映射。
  详见 [docs/dify-tool-contract.md](docs/dify-tool-contract.md)。
- **解析层只认写死的类型列表**。Dify 未来新增的节点类型按未知类型处理（可见诊断 + 不执行实际工作），
  不会自动获得实现。
- **`full` 不是"已对 Dify 验证"的同义词**。它是"没有检测到降级原因"的默认级别；
  与真实 dsh 引擎的执行证据以 [`docs/capability-report.md`](docs/capability-report.md) 为准。

提取依赖安装：`./scripts/install-extraction.sh`（Python 由 `DIFY_RUNTIME_PYTHON` 选择）。
依赖固定在 `requirements-extraction.txt`，默认安装到插件新建 `.vendor-extraction`，已存在则拒绝覆盖。
也可设置 `DIFY_EXTRACTION_VENDOR` 指向新的安装目录；正常提取自动把该目录及 `DIFY_PYTHONPATH` 加入搜索路径。
运行时不隐式安装，缺库给出可操作错误。未安装重量级 unstructured，旧格式转换仍列 S。

conversation 变量按会话 ID 与工作流绝对路径保存在工作区 `.dify-native-state`（可设 DIFY_STATE_DIR），成功 run 提交；不同会话隔离。并发/遗留锁明确失败，不自动重放；失败 run 的逐节点事务边界尚未证明官方等价。

定时入口使用显式五字段 cron + IANA timezone，安装 `./scripts/install-events.sh`，配置与去重/重启边界见 [事件部署](docs/event-deployment.md)。visual_config 原生转换尚未实现，须显式 cron。
