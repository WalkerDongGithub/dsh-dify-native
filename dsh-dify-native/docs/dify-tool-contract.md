# 声明式工具契约（declarative tool contracts）

Dify 的 `tool` 节点原本指向一个 **Dify 插件**（Python 实现，跑在 Dify 自己的 plugin daemon 里）。
本运行时没有那个 daemon，所以 `.difypkg` 插件形态的工具**不能执行**——这时节点会失败并明确报
"plugin packages … not supported"。

替代方案是一份 **YAML 契约**：把你需要的那一个工具（"拿配置 + 参数，发一个 HTTP 请求，从响应里取字段"）
写成声明，运行时按声明执行。没有 Python、没有 daemon、没有每个工具一份适配代码。

本文档描述的就是这个格式。所有行为以下面的实现为准：

| 代码 | 职责 |
| --- | --- |
| `lib/tool-contracts.js` | 契约的加载、占位符替换、HTTP 调用、响应映射 |
| `lib/provider.js`（`executeTool` / `runHarnessTool` / `toolAllowSet`） | `dify-node` provider 里的 `tool` 节点分派根 |
| `lib/dsl.js`（`toolArgumentsExpr` / `parameterObjectExpr`） | 把 DSL 的 `tool_parameters` / `tool_configurations` 编译进节点请求 |
| `lib/index.js`（`apply`） | 构造 provider 时的配置默认值 |

---

## 1. 工具节点解析顺序

`tool` 节点只按下面这个顺序解析，**没有**基于名字的猜测表
（把 `jina_reader` 映射到 `web_fetch` 会调用一个工作流没要的工具——正是本契约要消除的静默语义漂移）：

1. **白名单检查**（最先发生，先于任何解析）
2. **声明式契约**：`provider_name/tool_name` 命中已加载的契约 → 执行契约
3. **`.difypkg` 插件形态** → 明确拒绝
4. **显式 opt-in 的宿主工具**：`tool_name` 精确命中 `DIFY_TOOL_PASSTHROUGH`
5. 以上都不成立 → 拒绝，并列出当前已声明的工具

### 1.1 白名单 `DIFY_TOOL_ALLOW`

逗号分隔。命中规则是三种之一即放行：`*`（全放开）、`provider/tool`（完整请求名）、或单独的 `tool`。

```sh
DIFY_TOOL_ALLOW='my_company/search,jina_reader'   # 完整请求名，或单独的 tool 名
DIFY_TOOL_ALLOW='*'                                # 全放开
```

> 代码事实：白名单只做精确字符串比较，除单独的 `*` 外**没有**通配支持。默认值来自
> `lib/index.js`：`process.env.DIFY_TOOL_ALLOW ?? 'web_search,web_fetch'`，即不设环境变量时
> 只放行 `web_search,web_fetch` 这两个名字。未放行的请求在发起任何 HTTP 之前就失败。

### 1.2 `.difypkg` 插件形态

当 `provider_type` 有值且不等于 `builtin` / `api` 时，节点返回：

```
tool node <id> "<provider>/<tool>": Dify plugin packages (.difypkg, provider_type="plugin")
require the Dify plugin daemon and are not supported by this runtime.
Reproduce the tool with a declarative YAML contract (see docs/dify-tool-contract.md).
```

`provider_type` 缺省（空串）时**不会**走这条拒绝，而是继续去找 passthrough / 报"未声明"。

注意 `.difypkg` 的判断发生在**契约查找之后**：如果恰好有一份同名契约，契约优先。

### 1.3 显式 opt-in 的宿主工具（passthrough）

`DIFY_TOOL_PASSTHROUGH`（或 provider 选项 `toolPassthrough`）逗号分隔，列出**宿主已注册工具的确切名字**。
只有 `tool_name` 精确等于其中一项时才会经 `ctx.tools.execute` 分派；工具未注册则报错，不会静默成功。

```sh
DIFY_TOOL_PASSTHROUGH='web_fetch'
```

这个通道同样受 `DIFY_TOOL_ALLOW` 约束（白名单检查在最前面）。参数原样传递：
DSL 的 `tool_parameters` 成为宿主工具的 `arguments`；`tool_configurations` **不**传给宿主工具。
输出映射为 `{ text, result, json }`，宿主工具返回对象时其字段也会并入（不覆盖已有键），
`value.body.content` 会额外映射为 `body`。

---

## 2. 契约放在哪里

一份契约 = 一个 YAML 文件（`.yaml` / `.yml`）。运行时从 **根目录列表** 里递归扫描：

- 环境变量 `DIFY_TOOLS_ROOT`，**冒号分隔**多个目录（类 Unix `PATH` 写法）：

  ```sh
  DIFY_TOOLS_ROOT='/opt/dify-tools:/srv/workflows/tools'
  ```

- 或代码里构造 provider 时传 `createDifyNodeProvider(ctx, { toolRoots: [dir1, dir2] })`
  （`toolRoots` 优先于环境变量）；也可以直接传一个现成的 `toolRegistry`。

**实际加载时机**：`lib/index.js` 的 `apply(ctx)` 在插件挂载时调用
`createDifyNodeProvider(childCtx, { name: 'dify-node', python, pythonPath })`，**没有**传
`toolRoots`，所以插件路径下只会读 `DIFY_TOOLS_ROOT`。加载是**一次性的**（provider 构造时）：
改契约文件或改环境变量都需要重新加载插件 / 重启进程才生效。

扫描规则（`createToolRegistry`）：

- 目录不存在 → 跳过（没有契约 = 空注册表，不是错误）；
- 递归进入**所有**子目录，没有深度上限；
- 只处理扩展名为 `.yaml` / `.yml`（不区分大小写）的文件；大小为 0 的文件跳过；
- YAML 解析失败 → **静默跳过该文件**；
- 通过 `normalizeContract` 校验；不满足的文件（比如缺 `provider` / `tool`、没有 `request.url`）→ 静默跳过；
- 用 `provider/tool` 作为键登记；**同名后加载的覆盖先加载的**（顺序取决于目录遍历顺序，不保证确定）。
  被覆盖的旧契约仍会留在 `list()` 里重复出现，但 `get()` 拿到的是最后加载的那份。

> 静默跳过对部署方便，但排错时不友好：文件不生效时先检查工具执行失败信息中的
> "Declared tools" 列表，再看 YAML 是否有语法错误、`provider`/`tool`/`request.url` 是否齐全。

---

## 3. 完整 YAML 示例

```yaml
provider: jina            # 必填：对应 DSL 的 provider_name
tool: jina_reader         # 必填：对应 DSL 的 tool_name
label: { zh_Hans: 获取单页面 }   # 可选：仅信息展示用，运行时不做任何处理

# 可选（缺省为空数组）：声明契约会用到哪些值
parameters:
  # form: llm（默认）= 每次调用由 DSL 的 tool_parameters 提供
  - { name: url, type: string, form: llm, required: true }
  # form: form = 用户配置一次的值，来自 DSL 的 tool_configurations（被视为 credentials）
  - { name: api_key, type: secret-input, form: form, required: false }
  - { name: max_chars, type: number, form: llm, default: 8000 }

request:
  method: GET                       # 可选，默认 GET，统一转大写
  url: "https://r.jina.ai/{{parameters.url}}"    # 必填；必须能构造出绝对 URL
  query:                            # 可选（别名 params）：追加到 URL 查询串
    max: "{{parameters.max_chars}}"
  headers:                          # 可选
    Accept: application/json
    Authorization: "Bearer {{credentials.api_key}}"
  # body: ...    ← 省略即不发 body。若写映射 + body_is_json: true（默认），
  #                 每个值单独替换后整体 JSON.stringify，见第 5.3 节
  body_is_json: true                # 可选，默认 true

response:
  text: "{{response.data}}"         # 可选：输出 text
  json: true                        # 可选，默认 true：额外输出 json
  variables:                        # 可选：额外的输出变量
    title: "{{response.title}}"
    first_link: "{{response.links[0]}}"

settings:
  timeout_ms: 30000                 # 可选，默认 30000
```

---

## 4. 顶层字段与必填规则

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `provider` | **是**（非空字符串） | 否则整份文件被跳过 |
| `tool` | **是**（非空字符串） | 同上 |
| `label` | 否 | 仅保留在加载结果里，运行时不用 |
| `parameters` | 否 | 必须是数组，否则视为空 |
| `request` | **是**，且 `request.url` 必须是字符串 | 否则整份文件被跳过 |
| `request.method` | 否 | 默认 `GET`，转大写 |
| `request.url` | **是** | 替换占位符后必须能被 `new URL()` 解析，否则节点失败 `url is not absolute: …` |
| `request.headers` | 否 | 字符串 → 值 的映射（见第 5 节） |
| `request.query` / `request.params` | 否 | `query` 优先；`params` 是别名 |
| `request.body` | 否 | 见第 5.3 节 |
| `request.body_is_json` | 否 | 默认 `true`；只有显式写 `false` 才是文本 body |
| `response` | 否 | 见第 6 节 |
| `settings.timeout_ms` | 否 | 默认 `30000`；经 `Number()` 转换 |

注意：**未声明的字段不会报错，也不会被使用**。例如拼错 `response.variables` 只会导致没有额外输出；
拼错顶层键会被忽略。契约本身没有 schema 校验，只有上面这几条"是不是可用契约"的最低要求。

### 4.1 `parameters` 条目

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `name` | — | 必填，空名条目被跳过（不报错） |
| `form` | `llm` | `form` 表示来自 `tool_configurations`；其它任何值都按 `llm`（来自 `tool_parameters`）处理 |
| `required` | `false` | 只有严格等于 `true` 才算必填 |
| `default` | — | 没给值（或给了 `null` / `""`）时使用 |
| `type` | `string` | **目前只被保存，不参与任何转换或校验** |

值的解析顺序：先取 `form` 对应的来源（`llm` → `tool_parameters`，`form` → `tool_configurations`）；
若值是带 `value` 键的对象（Dify DSL 的 `{type, value}` 形状）则先解包 `value`；
为空则用 `default`；仍为空且 `required: true` → 节点失败：

```
tool <provider>/<tool>: required parameter "<name>" is missing
tool <provider>/<tool>: required configuration "<name>" is missing
```

`required: false` 且没有值的参数：不出现在替换作用域里（引用它会得到空串，见第 5 节）。

---

## 5. 替换语法

只有**三种固定查找**，刻意不是 Jinja——契约会拼 URL、带凭据，所以模板语言不允许执行任何东西：

| 占位符 | 含义 |
| --- | --- |
| `{{parameters.NAME}}` | DSL `tool_parameters` 里的值 |
| `{{credentials.NAME}}` | DSL `tool_configurations` 里的值（`form: form` 的参数） |
| `{{response.PATH}}` | 响应里的值；请求构造时响应尚不存在 |

也接受 `{{ parameters.NAME }}`（占位符内两侧空白可有可无）。不带 `NAME` 的裸 `{{parameters}}` /
`{{credentials}}` 也是合法的（整值形态会得到整个参数 / 凭据对象，混写形态会打印 `[object Object]`），
一般只在 `{{response}}` 上使用。

`PATH` 是点号 / 数字下标路径，例如 `{{response.data.items[0].title}}`。
一个段的形式是 `name[0][1]`（先取属性，再依次取整数下标）。路径中**不存在**的键得到 `undefined`：
在 header / query / body 里按空值规则整项省略（混写时替换成空串），
在 `response.text` 整值形态下得到空串，
在 `response.variables` 整值形态下输出的值就是 `undefined`（经节点 JSON 记录后该字段消失，
下游读它时等于"变量不存在"）。
索引只能取整数，不支持 `[-1]` 之类的负下标，也不支持切片语法。

**大小写敏感**：`{{parameters.q}}` 不等于 `{{parameters.Q}}`。

### 5.1 整值占位符 vs 混写

- 整个字符串**恰好**是一个占位符（两侧允许空白）→ 结果为该值的**原始类型**：

  ```yaml
  query: { n: "{{parameters.n}}" }   # n 是数字 3 → 查询串 n=3（而不是 JSON "[3]"）
  variables:
    whole: "{{response}}"            # 整个响应体（JSON 已解析时为对象，否则为原始文本）
  ```

- 占位符**混在文本里** → 文本插值，替换结果都转成字符串；空值替换成空串：

  ```yaml
  url: "https://r.jina.ai/{{parameters.url}}"
  headers: { Authorization: "Bearer {{credentials.api_key}}" }
  ```

### 5.2 header / query 规则（`renderMap`）

`request.headers` 和 `request.query` 是「键 → 模板字符串」的映射。对每一项：

1. 用 `renderValue` 替换（整值 / 混写规则同上）；
2. 值为 `undefined` / `null` / `""` → **整项不发送**；
3. 如果模板里含占位符，且**所有**占位符都解析为空 → **整项不发送**（哪怕字面前缀是 `Bearer `）。
   这正是 Dify 工具实现里 `if api_key:` 的语义：没有 key 就根本不发这个 header，而不是发 `Bearer `；
   没有占位符的纯字面量则总会发送；
4. 值若是对象 / 数组 → `JSON.stringify`，否则 `String(...)`。

query 参数用 `URLSearchParams.append` 追加。由于 `url` 模板本身就能带 `?key=1`，
最终查询串是「URL 模板里已有的参数」再拼上 `request.query`；`request.query` 里的**每个键只出现一次**
；如果 URL 已含同名键，会再追加一项。

**Content-Type 自动补全**：`body_is_json` 为真、body 已生成时，若 `headers` 里没有任何大小写形式的
`content-type`，会补上 `Content-Type: application/json`；写了则不再补。契约自身的 `headers`
原样交给 HTTP 客户端，不做键名规范化。

### 5.3 `request.body` 的实际行为

这是最容易误读的一处，按代码如实说明：

| `body` 的值 | `body_is_json` | 实际发送 |
| --- | --- | --- |
| 缺省 / `null` | 任意 | **不发送 body** |
| YAML 映射（`key: template`） | `true`（默认） | `JSON.stringify(renderMap(body))`，即一个 **JSON 文本字符串**，自动补 `Content-Type: application/json` |
| 字符串（含 `{{parameters.x}}` 之类） | `true`（默认） | **不解析也不结构化**：`renderMap` 收到非对象直接返回 `{}`，于是发送 `"{}"`（2 字节） |
| 字符串 | `false` | `String(renderValue(body))`——整值占位符得到该值的字符串形式，混写按文本插值 |

也就是说：**“JSON body”= 一个 YAML 映射逐键替换后整体序列化**，不是“模板字符串插值后原样发送”。
如果你需要把一段模板渲染成 JSON 文本、或者发送 `application/x-www-form-urlencoded` / 纯文本，
写 `body_is_json: false`。

`body_is_json: true` 且 body 是映射时，映射里每个值都经过 `renderMap` 规则：空值整键丢弃；
嵌套对象/数组会先 `JSON.stringify` 成字符串再放进 body——所以嵌套数组在 body 里是 `"[1,2]"` 这样的**字符串**。
需要真正的嵌套 JSON 时，目前的格式做不到；这是已知限制。

`body_is_json` 为真时，**不管 body 是映射还是字符串**都会自动补 `Content-Type: application/json`
（前提是 body 不是空、且自己的 headers 里没有 `content-type`）——即使 `body_is_json: true` 配了一个字符串 body。
`body_is_json: false` 时不补任何 `Content-Type`。
自己的 `Content-Type`（任意大小写）会阻止自动补全。

---

## 6. 响应映射

HTTP 返回后（非 2xx 直接失败，见第 7 节），先读完整响应文本，再尝试 `JSON.parse`：

- 解析成功 → 响应根 = 解析后的 JSON（对象 / 数组 / 数字 / 布尔 / null / 字符串）；
- 解析失败 → 响应根 = **原始文本字符串**。

然后生成输出：

| 输出键 | 规则 |
| --- | --- |
| `text` | 有 `response.text` 模板 → 模板输出的字符串；没有模板 → 原始响应文本。最终必定是字符串（字符串原样，非字符串值 `JSON.stringify`，`undefined` 变空串） |
| `result` | 等价于 `text` |
| `json` | 仅当 `response.json: true` 或未写时：JSON 解析成功 → 解析值；解析失败 → `{ body: <原始文本> }`。`response.json: false` 时不输出 |
| `<自定义名>` | `response.variables` 里每一项：`renderValue(模板)`，保留原始类型（整值占位符时是数字 / 对象 / 数组；混写时是字符串） |

`response` 段整个缺省（或为 `null`）时等价于 `{ text: 原始文本/JSON, json: 解析值 }`
——此时 `text` 保留原始响应文本。

节点成功后 `outputs` 里就是上面这些键，`meta` 为：

```json
{ "provider": "<provider>", "tool": "<tool>", "status": 200, "source": "/abs/path/contract.yaml",
  "engine": "declarative-contract", "requestedTool": "<provider>/<tool>" }
```

宿主工具 passthrough 的 `meta.engine` 是 `harness-tool`。

---

## 7. HTTP 调用与失败路径

HTTP 客户端：优先 `ctx.get('web').fetch`，否则 `globalThis.fetch`；都没有则失败
（`no HTTP client available to execute the tool contract`）。

超时：`settings.timeout_ms`（默认 30000ms），到时中止请求；调用方的取消信号也会中止请求。

以下情况都是**节点失败**（`ok: false`），不会产生"看起来成功"的输出：

| 情况 | 错误文本（节选） |
| --- | --- |
| 白名单不放行 | `tool node <id> refuses "<provider>/<tool>": allowlist is …, Set DIFY_TOOL_ALLOW to opt in.` |
| 缺必填参数 / 配置 | `required parameter "<name>" is missing` / `required configuration "<name>" is missing` |
| URL 不是绝对地址 | `url is not absolute: <模板>` |
| 没有 HTTP 客户端 | `no HTTP client available to execute the tool contract` |
| 请求抛错 / 中止 / 超时 | `request failed: <原因>`（超时原因是 `timed out after <N>ms`，取消是 `cancelled`） |
| 非 2xx | `returned HTTP <status>: <响应体前 400 字符>` |
| 未声明、未 opt-in | `"<provider>/<tool>" is not declared in this deployment. Declared tools: …` |
| `.difypkg` 插件 | `Dify plugin packages … are not supported by this runtime` |

---

## 8. 限制（如实）

- **只覆盖"一次 HTTP 请求 + 取字段"的工具**。需要签名算法、OAuth 刷新、多步调用、二进制上传、
  长连接的工具，用契约表达不了；这类工具应当被明确排除，而不是用近似实现冒充。
- **没有 `.difypkg` 支持**，也没有 plugin daemon。插件形态的工具要么写一份契约复现它的调用，
  要么就不要放进工作流。
- **没有参数类型系统**。`type` 字段被保留但不生效：没有类型转换、没有 JSON Schema 校验、
  没有默认值以外的校验。例如声明 `type: number` 并不会把字符串转成数字。
- **`body_is_json: false` 时没有预置的编码方式**，表单编码、multipart 都需要你自己在模板里拼好。
- **JSON body 只有一层映射**，嵌套值会先变成字符串（见 5.3）。
- **混写占位符始终产生文本**；需要原始类型（数字、数组、对象）时必须使用整值占位符。
- **契约文件出错是静默的**：YAML 语法错误、缺必填顶层字段的文件都被跳过，只在错误信息里的
  "Declared tools" 列表和你实际期望之间的差异上体现。
- **同名契约后加载者覆盖先加载者**，没有冲突报告。
- **契约在 provider 构造时加载一次**，运行中修改文件不生效。
- **契约指定的是真实外部 HTTP 服务**：本运行时只负责按声明发送请求，不对目标服务的身份、
  返回值业务语义做任何验证或担保（TLS 校验沿用 HTTP 客户端默认行为）。凭据来自 DSL 的 `tool_configurations`，
  会出现在按声明构造的 header / query / body 里——**契约文件与工作流都必须视为可信输入**。
- **宿主工具 passthrough 不传递 `tool_configurations`**，且宿主工具的入参校验由宿主工具自己负责。
- 每个工具调用都是**一次独立请求**，没有重试、没有缓存、没有速率限制。

---

## 9. 对应测试

离线测试，不需要 harness / 网络 / 模型（`fetch` 用桩替换）：

```sh
node tests/tool-contracts.test.mjs   # 加载、占位符、空值省略、响应映射、失败路径
node tests/tool-node.test.mjs        # tool 节点分派：契约 → .difypkg 拒绝 → passthrough → 拒绝
```

测试里已经覆盖的：递归加载与跳过不可用文件、嵌套目录、URL/凭据构造、空值省略 header、
JSON body、缺必填参数/配置、非 2xx、非 JSON 响应、DSL 形 `{type, value}` 参数解包、整值 `{{response}}`。

这份文档里**没有被测试覆盖**、只按源码读出的行为：`body_is_json: false` 的文本 body、
`default`、嵌套对象/数组在 body 里的字符串化、`request.query` 与 URL 自带查询串的合并、
超时与取消、`DIFY_TOOLS_ROOT` 环境变量的实际读取路径（测试都直接传 `toolRoots`）。

真实 dsh 引擎下的执行范围不在本文档范围内，以
[`docs/capability-report.md`](./capability-report.md) 为准。
