# dsh-dify-native

直接跑 Dify 导出的工作流 `.yml`，执行引擎用 dsh 自带的引擎、沙箱和模型服务，不用另外部署 Dify。

> **目的与意图**：想用更小的代价跑 workflow。部署完整 Dify 太笨重；用 agent 自然语言驱动没有确定性；
> 自己写编排脚本又没有生态。这个项目借 Dify 的 `.yml` 格式和画布确定性，用 dsh 的模型、沙箱、
> 工具把它执行掉——**dsh 出能力，Dify 出格式**。
>
> **它不保证能跑你的工作流。** 它是一个需求加一个方案：能力边界逐条写在下面，先用 `inspect`
> 判断，再决定要不要 `run`。后续会继续更新。

这篇 README 是给**用它的人**看的，回答三个问题：

1. [装好怎么用](#一安装三分钟) —— 三步，不需要改 dsh 源码。
2. [**哪些工作流能保证跑**](#二绿灯区能保证跑工作流) —— 经过真实引擎实测、有测试兜底的。
3. [**哪些工作流有风险**](#三黄灯区能跑但要看清代价红灯区大概率跑不通) —— 分黄、红两档，每种都写了具体会发生什么、怎么自查。

> 判断你自己那张图属于哪一档的方法在[第五节](#五自查先-inspect-再-run)：**先 `dify_native_inspect`，它会把每个节点标成 full / simplified / placeholder / passthrough，再决定要不要 run。**

> **这份 README 就是完整的使用说明。用之前先读完它，不需要问别人"这个能不能用"。**
> 判断依据都在这里：能力边界、已知降级、每一条的应对方式。README 没写的能力，默认按"不确定"处理——先 `dify_native_inspect`，别猜。

---

## 遇到问题

**本仓库会频繁更新。用之前先 `git pull`。**

发现 bug、和 README 描述不符、或者某个节点行为不对：**直接在仓库提 issue**。
主仓在 Gitea，GitHub 上是只读镜像；两边都能看，issue 在镜像侧提也可以。

提 issue 时带上这几样，能让问题一次定位：

- `dify_native_services` 的输出（说明这个 profile 到底挂了什么）
- `dify_native_inspect` 对该工作流的输出（说明这张图被判成了什么）
- 出错的节点 id + 完整错误信息
- 能复现的最小 `.yml`（脱敏后）

**不要问"这个能不能用"——README 的第二、三节已经按节点列清了。**
README 说不行而实际能跑，或者 README 说能跑而实际失败，都是 bug，都该提 issue。

> **已知问题（2026-10-18，已修，`git pull` 即可）**：在这个修复之前，`dify_native_inspect`
> 对**任何**真实导出的图都会报 `"value is not lossless JSON"`、一个字段都给不出来。
> 原因是 `deviations` 里混进了内部判定函数（`when`），dsh 校验工具返回值时会整包拒绝。
> 回归：`tests/tool-output-json.test.mjs`。

如果你是想改这个包的人和 agent：内部设计、诊断机制、文件职责在[文末](#八给开发者和-agent-的内部说明)，其中"为什么是这个形状"一节解释了两个被引擎接口逼出来的设计决定。

---

## 一、安装（三分钟）

### 1. 挂进 profile

先 clone（路径随意，下文用 `$PLUGIN` 指代你自己 clone 的那一层；公开镜像即可）：

```sh
git clone https://github.com/WalkerDongGithub/dsh-dify-native.git
cd dsh-dify-native && git pull         # 仓库更新频繁，每次用之前先拉
export PLUGIN="$PWD/dsh-dify-native"  # 插件在仓库的 dsh-dify-native/ 子目录
cd "$PLUGIN" && npm ci                 # 三个 JS 依赖（yaml/ajv/nunjucks），漏了插件加载就失败
```

然后挂进 profile：

```jsonc
// ~/.dsh/profiles/<name>/package.json
"dependencies": { "dsh-dify-native": "link:改成你 clone 的绝对路径/dsh-dify-native" }
```

`package.json` 里已经声明了 bundle patch，profile 的 `dsh.profile.bundles` 里加一行 `dsh-dify-native` 即可。
改代码即时生效，不需要重新打包。

### 2. 装可选依赖（只装你要用的）

```sh
cd "$PLUGIN"

./scripts/install-extraction.sh   # 只在用 document-extractor 时：PDF / DOCX / XLSX
./scripts/install-events.sh       # 只在用 cron 定时、webhook 入站时
./scripts/install-vendor.sh code  # 只在 code 节点 import jieba / json_repair 时
# 两者都是 scripts/install-vendor.sh <extraction|events> 的薄包装
```

两个脚本都装到插件**自己新建**的目录（`.vendor-extraction` / `.vendor-events`），不碰你现有 Python 环境；目录已存在会拒绝覆盖，所以重复跑是安全的。

### 3. 跑一张图

```jsonc
// dify_native_inspect —— 只解析，不执行，先看这张图什么成色
{ "path": "/abs/path/to/workflow.yml" }

// dify_native_run —— 真跑
{
  "path": "/abs/path/to/workflow.yml",   // 必填
  "inputs": { "llm_string": "{...}" },   // start 节点声明的变量
  "timeout": 120,                        // 单个 code 节点的超时秒数
  "tracePath": "/path/to/record.json"    // 可选：完整逐节点运行记录落盘
}
```

缺了 start 节点声明的必填变量时，会在启动引擎前就拒绝，不会跑一半才报错。

装完想确认环境到底暴露了哪些能力（引擎 / 沙箱 / 模型 / 工具），调 `dify_native_services`；想确认沙箱真的生效，调 `dify_native_sandbox_probe`。

---

## 二、绿灯区：能保证跑的工作流

"保证"在这里的意思是：**有真实引擎测试兜底，回归里断言的是实际 outputs 而不是"没报错"**。全部 18 个真实样本都走 `workflowEngine.start → 子进程 → sandbox/HTTP/工具 → outputs` 全链路，没有 mock 引擎，LLM 用固定回复，不花模型钱。

### 2.1 节点：可以放心用

| 节点 | 你需要注意的 |
| --- | --- |
| `start` / `end` / `answer` | — |
| `llm` | 见[3.1](#31-llm-实际跑在哪个模型上可能和你导出的不一样)——模型路由可能和导出时不符，但记录里可追溯 |
| `if-else` | 分支编译成普通 `if`，模型不参与决定走哪边 |
| `code` | **只在沙箱里跑**；拿不到沙箱直接拒绝执行，不会裸跑。支持 `python3` 和 `javascript` |
| `template-transform` | 完整两层语法：`{{#node.var#}}` 由编译器预替换，其余交给 Jinja2（经 nunjucks）。纯变量拼接零模型调用 |
| `variable-aggregator` | 按 Dify 1.9.1 语义取第一路**存在**的变量；组模式支持 |
| `assigner` / `list-operator` | — |
| `iteration` / `loop` | 编译成普通 `for` / `while`；`is_parallel: true` 用引擎的 parallel 组合子；支持嵌套容器 |
| `question-classifier` / `parameter-extractor` | 真实 provider 解析，固定 JSON 下逐字断言 |
| `template-transform` 的 Jinja 循环 / 过滤器 | `for` / `if` / `set` / 嵌套 / `upper` `round` `join` `default` `sort` `map` `sum(attribute=)` `tojson` `unique` 均可用；写错会报错，不会把模板原文当结果返回 |

`start` 的 `text-input` / `text_input` / `paragraph` / `number` / `select` 字段支持声明 `default`：输入缺省或为 `null` 时使用默认值，显式空串和 `0` 会保留；默认值在必填校验前应用。模板先替换 `{{#node.var#}}`，再由 Jinja 渲染局部变量；循环变量按 Jinja 作用域解析，局部变量的值不会被再次当作模板执行。

### 2.2 文档提取：可以放心用（需先装 extraction 依赖）

PDF、DOCX、XLSX、CSV、JSON、YAML、VTT（.vtt 保留原文）、txt 类文本。

- 用的是**固定版本的官方函数**（PDFium 4.30.0 / python-docx / pandas+openpyxl），不是另写一套；8 种格式的输出和官方函数**逐字相等**，有差分测试守着。
- 路由和 Dify 完全一致：**扩展名优先，没有扩展名才看 MIME**。49 个官方文本扩展名 + 8 个仅 MIME 格式都验证过。
- 一次提取多个文件时，**任何一个失败整个节点就失败**，不会悄悄跳过。
- 单文件文本上限 4 MiB，超了明确报错，不会静默截断成半截。

### 2.3 其他已验证的完整场景

| 场景 | 已验证到什么程度 |
| --- | --- |
| HTTP 请求（GET/POST 等，含自签证书站点） | `ssl_verify: false` 只对这一次请求关校验；`true` / 不写会校验证书；`null` 明确失败 |
| 普通 HTTP 成功后接下游节点 | 修过"成功后下游被跳过"的真实 bug，现在响应真的进下游 |
| 同会话多轮对话的状态 | 同会话同工作流跨 run 变量持久（1→2），不同会话互相隔离 |
| 定时触发 `trigger-schedule` | 五字段 cron + IANA 时区，槽时间是真实槽时间；重启补偿、持久去重 |
| 定时触发 visual_config | hourly / daily / weekly / monthly（含 last）四种频率 |
| webhook 入站 `trigger` / `trigger-webhook` | 真实 HTTP 监听 → 载荷/header/query 映射、鉴权、状态码、持久去重、`sys.*` 输出 |
| 人工等待 `human-input`（顶层） | 真等待 + 持久化快照，重开不重放上游副作用；提交/超时分支；动态表单与变量默认值 |
| agent 节点 | 显式 `dsh-bounded-tools` 有界工具循环：白名单、schema 校验、结果回灌、重复调用/上限/取消保护 |

### 2.4 18 个实测样本（可以直接参考写法）

| 样本 | 用到的节点 | 结果 |
| --- | --- | --- |
| `json-repair` | code | 修坏 JSON，真实 sandbox Python |
| `translation` | if-else, variable-aggregator | 两分支都跑，未执行分支不污染输出 |
| `seo-slug` | llm + 模板 | 标题真的注入了模型请求 |
| `jieba` | code | `你好世界` → `['你好','世界']`（注：样本写的是 paddle 模式，实际未用 Paddle 神经网络分词） |
| `form-demo` | assigner, code, if-else, template-transform | 登录成/败两分支，聊天分支走会话记忆 |
| `mature-ticket-triage` | if-else, iteration, parameter-extractor, aggregator, template | high/normal 两分支，顺序 iteration |
| `nodes-code-languages` | code（JS + Python） | 5 → JS 翻倍 → Python 加一 → 11 |
| `nodes-iteration` | iteration | 并行三项按序、空数组启动 0 个子 agent |
| `nodes-loop` | loop | rounds=3 → 三个输出对象 |
| `nodes-list-operator` | list-operator | 过滤/排序/截取 |
| `nodes-parameter-extractor` | parameter-extractor | 解析出 name/city |
| `nodes-parameter-extractor` / `nodes-agent` | agent | 见黄灯区 4.2 |
| `nodes-document-extractor` | document-extractor | 见黄灯区 4.3 |
| `nodes-datasource` | datasource | 见黄灯区 4.4 |
| `nodes-trigger` | trigger-webhook | 事件注入跑通 |
| `intent-reply` | question-classifier, knowledge-retrieval, aggregator | 见黄灯区 4.6（检索是词法不是向量） |
| `lang-consistency` | tool（jina_reader 契约） | 测试里用**本地 HTTP fixture**；直连公网 Jina 实测失败，见 3.5 |
| `python-coding` | llm | 回答代码，不执行代码 |

---

## 三、黄灯区（能跑但要看清代价）、红灯区（大概率跑不通）

### 黄灯：能跑，结果形状是对的，但语义**不是** Dify 的那个语义

这些节点跑得通、输出形状正确、测试也在跑，**但如果你把它当成"和 Dify 一致"就会踩坑**。`inspect` 会把它们标成 `simplified`。

#### 3.1 `llm` 实际跑在哪个模型上，可能和你导出的不一样

DSL 里的 `model.provider` / `model.name` 是**请求**，不是命令。实际路由顺序：

1. `DIFY_LLM_PROVIDER` + `DIFY_LLM_MODEL`（两个都设了才生效）
2. DSL 声明的 provider，**且当前 profile 真的注册了它**
3. profile 的默认模型
4. 都不满足 → 退回 DSL 声明，但标 `dsl-unverified`

**所以 DSL 写 deepseek、实际跑在 glm 上是完全可能的。** 好消息是每个 LLM 节点的记录里都有 `meta.provider` / `meta.model` / `meta.routeSource`，事后能查。"能不能接受这个模型差异"是你的事，但它不会瞒着你。

另外：样本里带 vision 配置的 llm 节点会有 `field-dropped` 诊断——**文本路径成功不等于图像理解成功**。

#### 3.2 `agent` 节点：跑的是替代策略，不是 Dify 原生 agent 插件

- 用的是显式 `dsh-bounded-tools` 有界工具循环（旧单轮路径也保留）。工具白名单、JSON Schema 校验、结果回灌、重复调用保护、上限、取消都验证过。
- **原生 agent 策略插件不支持**（需要 Dify plugin daemon）。
- **工具产生文件不会出现在最终 `files` 里**（一直固定 `files: []`）。
- **`memory` / window 已声明但不接真实会话**，不影响模型请求。
- **usage 只汇总 token 子集**，没有完整计费字段；**没有价格信息时不给费用数字**（不会给你编一个 0）。

#### 3.3 `document-extractor`：现代格式保证，老格式明确失败

- ✅ PDF / DOCX / XLSX / CSV / JSON / YAML / VTT / 纯文本：见 2.2。
- ❌ **`.doc` / `.ppt` / `.pptx` / `.epub` / `.eml` / `.msg` / `.xls` 会明确失败**（提示缺转换链/缺库）。它**不会**假装成功，也不会拿"按 ZIP 猜读"糊弄你。
- ❌ 不承诺 OCR，扫描版 PDF 提不出字。
- ❌ 不安装重量级 `unstructured`。

#### 3.4 `datasource` / `datasource-empty`：本地文件/网站可以，原生插件不行

- ✅ `sys.datasource_type` / `sys.datasource_info` 真注入；本地 file 与 website 信息输出；显式声明的 HTTP 远端契约。
- ✅ 显式 local/file records 保留（`.jsonl` 损坏会**失败**，不再吞错）。
- ❌ **原生 online_document / online_drive 插件不支持**，需要具体插件包 + 账户 + Dify 文件存储配置。
- ❌ 不会去猜插件路径（这是修过的真实 bug）。

#### 3.5 `tool` 节点：只有两条路，且 `.difypkg` 一定不行

按顺序：

1. **声明式 YAML 契约**（放进 `~/.dsh-dify/tools` 即可，无需配置；也可用 `DIFY_TOOLS_ROOT` 指定，一次 HTTP 请求 + 响应字段映射）；
2. **显式 opt-in 的宿主工具**（`DIFY_TOOL_PASSTHROUGH` 里列出的确切工具名）；
3. 否则拒绝。

关键点：

- **`.difypkg` 插件形态的工具不支持**——需要 Dify plugin daemon，明确拒绝。
- **没有名字猜测表**：`jina_reader` 不会被偷偷换成 `web_fetch`。
- 契约只覆盖"一次 HTTP 请求 + 取字段"：**没有参数类型转换、没有 schema 校验、JSON body 只有一层映射**；OAuth、多步调用、需要签名的工具表达不了。
- 契约会把 `tool_configurations` 当凭据拼进请求，所以**契约文件和工作流都必须可信**。
- 契约格式见 [docs/dify-tool-contract.md](docs/dify-tool-contract.md)。

**从零加一个工具**（复制即可改）：把下面这份存成 `~/.dsh-dify/tools/mysearch.yaml`，
工作流里 `provider_name: mysearch` + `tool_name: search` 的 tool 节点就能跑了。

> ⚠️ **契约在插件挂载时一次性加载**，新增/修改 YAML 后要**重启 DSH**（或重新加载插件）才生效。
> 改完还是找不到，先调 `dify_native_services` 看 `contractRoots` 里列的是不是你放的那个目录。

```yaml
provider: mysearch
tool: search
label: { zh_Hans: 我的搜索 }
parameters:
  - { name: q, type: string, form: llm, required: true }     # 来自节点 tool_parameters
  - { name: api_key, type: secret-input, form: form, required: true }  # 来自 tool_configurations
request:
  method: GET
  url: "https://api.example.com/search?q={{parameters.q}}"
  headers: { Authorization: "Bearer {{credentials.api_key}}" }
response:
  text: "{{response.body}}"          # 整段返回文本
  variables:
    - { name: title, value: "{{response.title}}" }   # 映射成节点输出变量
```

还需要 `DIFY_TOOL_ALLOW` 放行这个工具（默认只放行 `web_search,web_fetch`），
例如 `DIFY_TOOL_ALLOW=mysearch/search` 或 `*`。
- ⚠️ 样本里那个 `jina_reader` 契约直连 `r.jina.ai`，**在本机实测请求失败**（`fetch failed`，curl 探测 20 秒超时），测试是用本地 fixture 端点验证的。也就是说：**这条链路你这边现在跑不通，需要你自己处理网络或换端点。**

#### 3.6 `knowledge-retrieval`：不是向量检索

在本地目录上做**词法 grep**（含 CJK bigram），不是 embedding、不是向量库。

- `dataset_ids` 会按 `DIFY_KNOWLEDGE_ROOT`（默认 `<workspace>/knowledge`）解析成本地目录；找不到就**报错并列出缺失的 id**，不会静默返回空。
- 注意：写成绝对路径的 id 会原样使用。

#### 3.7 `http-request` 的 timeout：三个键折成一个总截止时间

`timeout.connect` / `read` / `write` 三个键**会被读取并生效**，但实现上是折合成一个 `curl --max-time` 总截止时间，**不是三个独立阶段预算**。所以 `inspect` 如实报 `simplified`。你要的是"请求别超过 N 秒"——可用；你要的是"连接 1 秒、读 5 秒"这种精细控制——做不到。

### 红灯：大概率跑不通，或者跑了也不算数

| 你的工作流里有… | 会发生什么 | 怎么办 |
| --- | --- | --- |
| **`.difypkg` 插件工具** | 明确拒绝执行 | 改写成声明式 YAML 契约，或换成宿主已有工具 |
| **原生 agent 策略插件** | 不执行，走替代策略或失败 | 接受 `dsh-bounded-tools` 替代，或别用 |
| **原生 datasource / online_drive 插件** | 不支持 | 用声明式远端契约，或本地文件 |
| **原生插件事件订阅**（`trigger-plugin` 订阅） | 不执行原生订阅；只有显式 `bridge: true` 的 HMAC 签名 HTTP 桥能顶一部分 | 用 webhook + 签名桥 |
| **原生 Dify 调度服务互通** | 不接 `ScheduleService`，只有本地声明的 cron | 用本地 cron |
| **容器内（iteration/loop 里）的 `human-input`** | inspect 报 `node-unsupported`、support 为 `rejected`，编译前拒绝 | 把人工等待挪到顶层 |
| **高级表单字段（select / file）** | inspect 报 `node-unsupported`、support 为 `rejected`，编译前拒绝；只支持 text / paragraph | 降低表单类型 |
| **`human-input` 到期自动恢复** | 不会自动跑，需要你显式调 `dify_native_resume` 或轮询 | 自己写轮询 |
| **multipart / 二进制 / 文件上传 webhook** | 显式拒绝这些 content_type | 先上传拿文件描述再传 |
| **webhook 异步返回 / 自定义 response_body / 长超时** | 只实现了状态码配置；同步返回运行记录 | 别依赖异步模式 |
| **`knowledge-index`** | 会被调度，但**什么都不写**（没有向量库），返回 `status: not_written, indexed: 0` | 别指望它建索引 |
| **Dify 未来版本的新节点类型** | 标 `node-unknown` + `passthrough`：**不报错、图继续走、但不干这个节点的活** | 这是最阴的一种，务必先 inspect |
| **`custom-note`** | 只是画布标注，本来就不执行 | — |

---

## 四、安全边界：只跑可信来源的 `.yml`

这条单独拎出来，因为它是**当前设计上的边界，不是可以靠配置绕过的**。

### 4.1 Jinja 模板不是沙箱

`template-transform` 的模板在 JS 侧由 nunjucks 渲染，而 nunjucks **不是沙箱**：模板里的属性访问可以沿着 JS 原型链走到宿主运行时。例如：

```jinja
{{ a["constructor"]["constructor"]("return process")() }}
```

在当前 Node ESM 环境下，这样能取到 `process` 对象。进一步的利用（`process.mainModule.require` 读文件）目前被 ESM 环境挡住——但那是**环境巧合，不是设计保证**。

`lib/jinja.js` 已经在 nunjucks 的 `runtime.memberLookup` 上拦截了 `constructor` / `__proto__` / `prototype` 等一组危险属性名，实测上面这行会被告警挡住、正常属性访问不受影响。但这是**一层缓解，不是完整沙箱**：模板仍然能调用上下文里传入的函数。

**结论：只运行你自己可信来源的工作流。不要让不可信用户提交的模板直接跑。** 真要彻底解决，需要把模板渲染放进 `ctx.sandbox` 隔离的子进程——那是另一项工作。

### 4.2 其他边界

- **`code` 节点**：只在 `ctx.sandbox.confine` 里跑，没有沙箱直接报错，不降级裸跑。但本机沙箱后端是 `landlock-run`，报 `partial` enforcement（旧 Landlock ABI），**不能据此声称完整隔离**。
- **`document-extractor`**：本地路径必须解析在 workspace 或 `DIFY_DOCUMENT_ROOT` 之内，越界拒绝。
- **`tool` 节点**：白名单先于任何解析；默认 `web_search,web_fetch`，精确匹配没有通配；`DIFY_TOOL_ALLOW=*` 全放开（慎用）。

---

## 五、自查：先 inspect 再 run

**这是判断"我这张图行不行"最快的方法，比读文档准。**

`dify_native_inspect` 只解析不执行，返回每个节点的支持级别和被丢弃的字段：

```
full         没有检测到降级原因 —— 注意：是"没检测到"，不是"已和 Dify 逐字段验证过"
simplified   只实现了 Dify 语义的子集（带理由）
placeholder  被调度了，但不做该节点的实际工作
passthrough  未知类型，图能继续走，但不执行该节点的实际工作
```

同时会报诊断：

```
field-dropped          DSL 写了值，但运行时不读这个字段，值被忽略
node-simplified        节点只实现了子集
node-placeholder       节点被调度但不干实际工作
node-unknown           未知节点类型，passthrough
template-jinja-invalid 模板写错了（执行到该节点会失败，但 inspect 阶段就能看到）
note                   编译器自己的结构性提示
```

**看 `field-dropped` 和 `node-unknown` 就够了**：出现前者说明你图上某个设置不会生效，出现后者说明有个节点根本不会被执行。

诊断**从不改变行为**：带诊断的图照样执行、照样返回 `succeeded`。所以别拿"跑成功了"当"语义对了"的证据。

---

## 六、环境变量

全部可选：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DIFY_LLM_PROVIDER` + `DIFY_LLM_MODEL` | — | 强制 LLM 路由，**两个都要设才生效** |
| `DIFY_TOOL_ALLOW` | `web_search,web_fetch` | tool 节点白名单，逗号分隔，精确匹配；`*` 全放开 |
| `DIFY_TOOLS_ROOT` | —（无契约） | 声明式工具契约根目录，**冒号分隔**多个，递归扫 `*.yaml` / `*.yml`；约定目录 `~/.dsh-dify/tools` 总是会被扫描，此变量在其**之后**，同名覆盖约定目录 |
| `DIFY_TOOL_PASSTHROUGH` | —（不放开） | 允许 tool 节点按**确切名字**调用的宿主工具，逗号分隔 |
| `DIFY_KNOWLEDGE_ROOT` | `<workspace>/knowledge` | knowledge-retrieval 的数据集根目录 |
| `DIFY_DATASOURCES_ROOT` | —（无契约） | datasource 契约目录，**冒号分隔**；格式同工具契约，约定目录 `~/.dsh-dify/datasources` 总是会被扫描。见 [datasource 协议](docs/datasource-contract.md) |
| `DIFY_DOCUMENT_ROOT` | `<workspace>` | document-extractor 的文件根目录 |
| `DIFY_RUNTIME_PYTHON` | `python3` | 执行 code 节点的解释器 |
| `DIFY_PYTHONPATH` | 自动探测 | Python 的 `PYTHONPATH` |
| `DIFY_VENDOR_DIR` | 同 `DIFY_PYTHONPATH` | code 节点 `dependencies` 的安装目录 |
| `DIFY_EXTRACTION_VENDOR` | `.vendor-extraction` | 文档提取依赖的安装目录 |
| `DIFY_EVENTS_VENDOR` | `.vendor-events` | cron / event 依赖的安装目录 |
| `DIFY_STATE_DIR` | `<workspace>/.dify-native-state` | conversation 状态的落盘目录 |
| `DSH_DIFY_RUNTIME_ROOT` | 插件根目录 | code 节点 Python 库（jieba / json_repair）的根；默认找插件自己的 `.vendor-code` |
| `DSH_ENTRY` | PATH 里的 `dsh` | 手动指定 dsh 发行版入口（只有跑测试时需要） |

---

## 七、我自己验证一遍

```sh
cd "$PLUGIN"
./tests/run-all.sh        # → ALL TESTS OK
```

**这不是纯离线单元测试。** 34 个测试入口里主体是**打到你机器上已装 dsh 的真实引擎测试**：真实 `workflowEngine.start`、真 sandbox 子进程、真 HTTP 回环服务、真 Python 提取。LLM 用固定回复，不花模型钱。

它需要：已装 dsh（本机 0.2.0-rc.2）、可用的本地 sandbox 后端、Node、Python3、ripgrep，以及提取/cron 的显式依赖（就是上面两个 `install-*.sh`）。`package-deployment` 那项还需要 npm registry 网络。**任何缺失或失败都会让整个脚本退出失败——不 skip、不吞错。**

> 需要说明边界：这套测试证明的是"实现符合意图、真引擎确实跑出这些 outputs"，**不**证明"和 Dify 官方执行器逐字段一致"，也不构成"你的工作流能跑"的承诺。后者只对文档提取做了逐字差分（8 种格式）。逐节点能力证据以 [docs/capability-report.md](docs/capability-report.md) 为准，剩余缺口逐条列在 [docs/semantic-gaps.md](docs/semantic-gaps.md)（非 RAG 共 23 项，其中 17 项可本地继续做、6 项必须要有真实插件/账户/部署资料）。

---

## 八、给开发者和 agent 的内部说明

<details>
<summary>展开：内部架构、设计决定、文件职责、测试清单</summary>

### 8.1 链路

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

`lib/` 不 import 任何 `@deepseek-ai/*` 运行期类，全部从注入的 Cordis 上下文里取。**dsh 源码零改动。**

三个 JavaScript 依赖（`yaml` / `ajv` / `nunjucks`）都由插件直接声明并锁定，装在插件自己的 `node_modules`。源码检出用 `npm ci`。

### 8.2 六个工具

| 工具 | 作用 |
| --- | --- |
| `dify_native_inspect` | 解析 + 预览编译，列出支持级别和被丢弃的字段。不执行任何东西。 |
| `dify_native_services` | 报告当前 profile 暴露了哪些能力：engine / sandbox / subagent providers / LLM providers / models / 默认模型 / 工具。 |
| `dify_native_sandbox_probe` | 在**活的 harness 里**证明沙箱真的生效：workspace-write 能写、read-only 被拒。 |
| `dify_native_run` | 编译并执行，返回工作流最终 `outputs` 加逐节点记录。 |
| `dify_native_resume` | 向持久化的 `human-input` 等待点提交显式 action；已完成的提交绝不重放。 |
| `dify_native_events` | 启动显式配置的本地事件监听，直到 context 被 dispose。 |

### 8.3 为什么是这个形状

有两个被引擎接口逼出来的设计决定，它们解释了这个包为什么长成这样。

**1. 节点分派只能发生在 subagent provider 上。** 工作流引擎交给脚本的宿主钩子只有一个：`agent(prompt, opts)`。`opts.provider` 指的是 **LLM 路由**，不是 subagent provider——subagent provider 在整轮 run 里是固定的。所以做不到"每个节点换一个 provider"，只能整轮挂一个 `dify-node` provider，由它在每次 `agent()` 调用时收到一份 JSON 节点请求，按里面的 `kind` 分派。这不是取巧，这是在不改 dsh 源码的前提下**唯一**的非侵入位置。

**2. 分支是代码，不是运行期调度器。** `if-else` / `question-classifier` / `http-request` / `human-input` 的出边 handle 是**预声明的分支名**。编译器把它们翻译成普通的 `if` 块，并给每个节点一个激活守卫：

```js
if ((__ran["s"] === true)) { /* 入口节点 */ }
if ((__ran["br"] === true && __branch["br"] === "true")) { /* true 分支 */ }
```

没被激活的节点不执行，它的结果变量保持 `undefined`。于是**汇合点不需要任何运行期调度逻辑**——直接读变量就行。模型只负责回答问题，从不决定走哪条边。

### 8.4 解析层覆盖的节点类型

`lib/dsl.js` 认识 Dify 前端 `BlockEnum` 里的 **30 个类型**（见 `tests/coverage.test.mjs` 里的 `BLOCK_ENUM` 列表，以该列表为准），再加 3 个导出里出现的别名 / 标记（`custom-note`、`iteration-end`、`trigger`），全部归一化成 IR kind，没有一个会掉到 `generic`。

**这只是解析层的事实**：它证明"认识"这些类型，不等于"执行语义完整"。而且它只覆盖写死的列表——Dify **未来版本**新增的节点类型不在里面。

`full` 是**默认级别**：它意味着"**没有**检测到降级原因"，而不是逐字段对照 Dify 验证过的结论（一条 `full` 记录可能是"实现了"，也可能只是"没有触发任何已知的降级规则"）：
- 节点声明了运行时未实现的字段，会自动降为 `simplified`（理由 `some declared fields were dropped`）；
- 但没有声明、或运行时根本没扫描到的字段，不会触发降级。

被丢弃字段的扫描会跳过纯展示字段（`position`、`width`、`internals` 等 Canvas 元数据），也会放过"值本来就等于默认值"的模型参数（`top_p: 1`、零 penalty）。

### 8.5 `variable-aggregator` 的选择规则

按 Dify 1.9.1 的 `VariableAggregatorNode._run` 实现：取第一路**存在**的变量（未运行的节点 = `undefined`），**只判断存在性，不看内容**。所以第一路分支真的运行了、但值为 `null` 或空串（`""`）、`0`、`[]` 时，结果就是那个 `null` / 空值——**不会**继续往后找。高级设置开启分组（`advanced_settings.group_enabled`）时按组各自选。

### 8.6 会话记忆与系统变量

Dify 的 `memory`（`TokenBufferMemory`）和 `sys.*` 直接映射到 harness 的 session log，不引入自己的会话存储。

**`memory`** —— `session.deriveMessages()` 的结果转成 Dify 形状，过两道滤网：(1) 只有 `source.kind === 'user'` 的消息才算用户轮次（循环注入的指令/快照/catalog 不算）；(2) 带 tool-call 的 assistant 消息是 agent 的工作过程不是回答，跳过。然后按 `memory.window.size` 裁窗口（Dify 语义：最近 N **条**消息，不是 N 对），按 `role_prefix` 渲染（默认 `Human:` / `Assistant:`）。

**`sys.*`** —— 编译进脚本的 `__vars.sys`，从 `args['sys.*']` 读：`sys.conversation_id` ← 调用方 harness session 的 id；`sys.dialogue_count` ← 真实用户轮次数。刻意**不**从会话里臆造 `sys.query` / `sys.files`：一轮 run 的当前输入是调用方传的 `inputs`，不是"agent 上次说的话"。没有活会话时这些变量保持 Dify 默认值。

### 8.7 状态持久化

conversation 变量按 `session.id + 工作流绝对路径` 保存在 `.dify-native-state`（或 `DIFY_STATE_DIR`）。写临时文件 fsync 后原子 rename；锁冲突明确失败，**绝不自动清理旧锁或重放**。成功运行提交变量，失败不提交——失败节点前已写变量与官方事务边界是否等价，仍是一个 S 子项。

### 8.8 文件职责

| 文件 | 职责 | 行数 |
| --- | --- | --- |
| `lib/dsl.js` | 解析 Dify DSL → IR → 编译编排脚本。校验图结构、拓扑排序、分支守卫。 | ~1940 |
| `lib/provider.js` | `dify-node` provider：按 kind 分派节点，每个节点一个 capability 实现；tool 节点分派根。 | ~1810 |
| `lib/index.js` | Cordis 插件：注册 provider + 六个工具，渲染 inspect/run 输出。 | ~570 |
| `lib/tool-contracts.js` | 声明式工具契约：加载 YAML、替换三种占位符、一次 HTTP 调用、响应映射。 | ~330 |
| `lib/jinja.js` | `template-transform` 的 Jinja2 渲染（nunjucks + 过滤器补齐 + 属性访问防护）。 | ~235 |
| `lib/session-history.js` | Dify memory ↔ harness session log 的适配层。 | ~130 |
| `lib/diagnostics.js` | 诊断收集器 + 字段丢弃扫描。无依赖、无副作用。 | ~135 |
| `lib/runtime-state.js` / `lib/event-runtime.js` | 持久状态、事件桥运行时 | 小文件 |
| `lib/*.py` | 固定官方提取函数、cron 槽计算、调度解析 | — |

`dsl.js` 和 `provider.js` 都是纯翻译层 / 能力层——它们不调度、不隔离、不连模型。

### 8.9 测试清单（`run-all.sh` 共 34 个入口）

| 文件 | 覆盖 |
| --- | --- |
| `dsl.test.mjs` | 解析、IR、编译、拒绝不合法的图 |
| `nodes.test.mjs` / `nodes-new.test.mjs` | 节点执行语义 / 后补节点 |
| `control-semantics.test.mjs` | 控制流语义（分支、守卫、容器） |
| `coverage.test.mjs` | 30 个 `BlockEnum` 类型解析到已知 kind；`../dsl/*.yml` 样本零未知类型、全部可编译 |
| `diagnostics.test.mjs` | 诊断只在真缺口时出现，且从不升级成编译错误 |
| `template-jinja.test.mjs` | 模板替换与 Jinja2 渲染 |
| `session-memory.test.mjs` / `sys-vars.test.mjs` | 记忆滤网/窗口/role_prefix；系统变量 |
| `code-file-input.test.mjs` | code 节点的文件输入 |
| `provider.test.mjs` | classifier / http-request / tool 白名单 / knowledge-retrieval |
| `tool-contracts.test.mjs` / `tool-node.test.mjs` | 声明式契约；tool 节点分派（契约 → `.difypkg` 拒绝 → passthrough → 拒绝） |
| `structured-output.test.mjs` | structured_output 的 ajv 校验，含一次重试回合 |
| `translation-script.test.mjs` / `container-scope.test.mjs` | 分支编译成普通 `if`；容器作用域及嵌套回归 |
| `engine-e2e.test.mjs` / `engine-nested.test.mjs` | 真实 dsh 引擎的 18 样本矩阵、分支、失败和嵌套容器 |
| `engine-extraction.test.mjs` / `engine-extraction-differential.test.mjs` / `engine-extraction-routing.test.mjs` | 数组/长文本/远程 bytes/失败；8 格式与官方函数逐字差分；49 扩展 + 8 MIME 路由 |
| `engine-datasource.test.mjs` / `engine-agent-loop.test.mjs` / `engine-conversation.test.mjs` | sys 与形状；有界工具循环；跨 run 状态与会话隔离 |
| `engine-events.test.mjs` / `engine-schedule.test.mjs` / `engine-schedule-visual.test.mjs` | 真实 listener/鉴权/去重/HMAC 桥；cron 时区/补偿；四种 visual 频率 |
| `engine-human-wait.test.mjs` / `engine-human-form.test.mjs` | 等待→重开→提交→分支、不重放；动态表单与默认值 |
| `engine-http-follow.test.mjs` / `engine-http-tls.test.mjs` / `engine-http-timeout.test.mjs` | 后继节点；ssl_verify 四态；timeout 键被消费 |
| `package-deployment.test.mjs` | 临时 `npm pack` + 独立 `npm install`；`CLEAN PACKAGE IMPORT OK` |

测试覆盖的是**已验证的范围**：`coverage.test.mjs` 扫描的 `../dsl/*.yml` 样本、以及各测试里构造的图。它们不能推出"任意 Dify 工作流都可运行"。`coverage.test.mjs` 对样本只断言两件事：零未知类型、零解析/调度 issue、能编译成脚本——它**不**要求所有节点都是 `full`。

### 8.10 其他协议文档

- [docs/capability-report.md](docs/capability-report.md) —— 当前执行能力与语义余项
- [docs/semantic-gaps.md](docs/semantic-gaps.md) —— 23 项 S 子项逐条验收条件
- [docs/reachability-audit.md](docs/reachability-audit.md) —— 原始可达性审计与历史证据
- [docs/deployment.md](docs/deployment.md) —— npm ci/pack 与 Python 依赖安装
- [docs/dify-tool-contract.md](docs/dify-tool-contract.md) —— 工具契约格式与限制
- [docs/control-semantics.md](docs/control-semantics.md) —— 控制流语义
- [docs/datasource-contract.md](docs/datasource-contract.md) / [docs/agent-strategy.md](docs/agent-strategy.md) / [docs/event-deployment.md](docs/event-deployment.md) / [docs/human-wait.md](docs/human-wait.md)

官方基线：[cd47a47c](https://github.com/langgenius/dify/tree/cd47a47c3b4acc4d4457b73777722602c33bc950)（文档提取 / datasource / agent / HTTP），trigger* / human-input 另固定 [5dff2467](https://github.com/langgenius/dify/tree/5dff24671d7eb0db087a01b699444d2f1939f17e)。普通 `trigger`、`datasource-empty` 是本地扩展/别名，没有伪造官方独立节点。

</details>
