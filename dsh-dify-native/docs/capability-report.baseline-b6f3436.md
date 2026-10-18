> 历史封存：以下为 b6f3436 的原始能力报告，不描述当前实现。当前状态见 [capability-report.md](capability-report.md)。

# 真实执行能力报告

验证日期：2026-10-18。入口：`node tests/engine-e2e.test.mjs`，也已纳入 `./tests/run-all.sh`。

## 已经证明的范围

**18/18 个样本真实进入工作流引擎并断言最终 outputs，25 次原样本运行。** 另有登录状态分支、未声明工具、code 异常、human-input 两个动作、knowledge-index、嵌套 iteration 的真实引擎运行，以及必填输入拒绝测试。共 33 次真实引擎运行（含独立嵌套容器回归两次）；缺输入用例另计，在启动前拒绝。没有 skip，也没有把执行失败当成功断言。

测试使用 PATH 中已安装的 dsh（本机 0.2.0-rc.2），在 Cordis 中装载与 profile 相同发行版的 `dsh-workflow-ptc`、Node PTC runtime、SubagentRuntime、LocalSandboxProvider、session、tools 和真实 grep 服务，再加载本插件。运行链：

`dify_native_run.execute → ctx.workflowEngine.start → PTC 独立 Node 进程 → ctx.subagents.start → dify-node → sandbox / tools / 文件 / LLM → 最终 outputs`

只有 LLM 使用固定回复流，不访问模型 API。Python/JavaScript code 节点运行真实子进程，基线断言 sandbox 后端存在。本机后端是 `landlock-run`，报告 `partial` enforcement（旧 Landlock ABI），不能据此声称完整隔离。

**工具服务的边界必须单列：** `lang-consistency.yml` 使用测试部署声明的 `jina/jina_reader` YAML 契约和本地 HTTP 服务；URL 参数、真实 HTTP、JSON 响应映射、Python 解析、三个语言选择及最终输出都被验证。没有替换引擎、provider、HTTP fetch 或契约执行器，但这个本地端点是测试数据源，**不能算作外部 Jina 服务可用的证明**。使用现有 `../tools/jina.yaml` 请求公网 Jina 的实测失败：节点 `17310793844280` 返回 `request failed: fetch failed`，另一次 curl 探测 20 秒超时。因此“18 个样本在任意原部署环境都可直接跑通”没有被证明；公网 Jina 这一路目前跑不通。

## 样本矩阵

“跑通”均表示检查了实际 outputs，不代表完整 Dify 产品语义或真实模型生成质量。

| 样本 | 真实引擎结果 | 已断言的值 / 分支 / 限制 |
| --- | --- | --- |
| form-demo.yml | 跑通 | 登录失败返回完整 HTML 表单；成功返回“登录成功，我们聊点什么？”；额外预置 DSL conversation 默认 token 后走聊天分支，返回 `welcome back` |
| intent-reply.yml | 跑通 | 两个 classifier 类别均执行；最终 output 分别带对应类别标记；使用帮助分支实际 grep 本地知识文件并断言检索内容 |
| jieba.yml | 跑通 | `你好世界` → answer `['你好', '世界']`；样本指定 paddle 模式，但当前 jieba 环境未证明使用了 Paddle 神经分词 |
| json-repair.yml | 跑通（基线） | `{name: "Ada",}` → output 可解析为 `{"name":"Ada"}`；真实 sandbox Python 进程 |
| lang-consistency.yml | 配置本地契约端点后跑通；公网 Jina 跑不通 | 三种基准语言分别执行；每次真实发出三个 HTTP 请求；检查基准内容和 cn/en/jp 最终 outputs；公网失败见上文 |
| mature-ticket-triage.yml | 跑通 | high / normal 均执行，检查另一分支未运行；完整 reply、advice、keywords；顺序 iteration 输出两个关键词 |
| nodes-agent.yml | 跑通（simplified） | answer `研究完成`；实际经过单次 LLM 调用，toolsExecuted 为空 |
| nodes-code-languages.yml | 跑通 | n=5 → JavaScript 加倍 → Python 加一 → result=11 |
| nodes-datasource.yml | 跑通（simplified） | 读取真实 records.jsonl，两条记录；最终模板包含第一条 Ada 记录 |
| nodes-document-extractor.yml | 跑通（simplified） | 读取真实 doc.txt，最终 text 与完整文件内容相等，failed=0 |
| nodes-iteration.yml | 跑通 | 真实 parallel 三项按序输出 `第0项: a` 等；空数组 → result=[]，未启动子 agent |
| nodes-list-operator.yml | 跑通（有字段诊断） | 四条记录过滤、排序、截取后输出 score 8、3，count=2 |
| nodes-loop.yml | 跑通 | rounds=3 → round-0 / round-1 / round-2 三个输出对象 |
| nodes-trigger.yml | 跑通（事件注入） | topic=deploy → `触发主题: deploy`；没有启动 webhook HTTP 监听服务 |
| python-coding.yml | 跑通 | LLM 固定流 → 最终 answer `print("hello")`；这是回答代码的工作流，不会执行生成的 Python |
| seo-slug.yml | 跑通 | 检查 title 被注入实际 LLM 请求；固定流 → output `hello-world` |
| translation.yml | 跑通 | country 为空 / Canada 均执行；检查实际分支及未执行分支；建议传入最后一次模型请求，最终 outputs 分别为对应标记 |
| nodes-parameter-extractor.yml | 跑通 | 真实 provider 解析固定模型 JSON，最终 name=张三、city=北京、success=1 |

form-demo 的聊天分支使用解析后 DSL 中预置的 conversation 默认值，其他节点/边不变，仍由真实引擎运行。**当前 runner 每次重新初始化 conversation 默认值，没有证明跨 run 保持登录状态。** 原样本两次登录测试与这次预置状态测试分开计数。

## 节点支持级别

这些级别是当前承诺的实现范围，full 不是“兼容 Dify 全部字段”。`inspectGraph().support` 和节点 warnings 还会根据具体 DSL 的丢弃字段将单个节点降为 simplified。

| 级别 | 类型 | 当前语义 / 证明范围 |
| --- | --- | --- |
| full（所支持字段范围内） | start、end、answer、code、if-else、question-classifier、template-transform、assigner / variable-assigner、variable-aggregator、parameter-extractor、iteration、iteration-start/end、loop、loop-start/end | 本次真实链路覆盖输入、输出、条件分支、代码、聚合、模板、提取及容器执行；未覆盖所有字段组合 |
| full（有限部署协议） | llm、tool、http-request、list-operator | LLM 文本流；tool 执行部署声明契约或显式允许的 harness 工具；HTTP/列表仅限实现支持的选项。本次覆盖 tool 契约 HTTP，未用独立 http-request 节点证明所有 HTTP 模式 |
| simplified（实例可能显示 full） | trigger、trigger-schedule、trigger-webhook、trigger-plugin | 将 run args 当事件载荷；不创建调度器、webhook listener 或 Dify 插件订阅。inspect 中 trigger-webhook 为 full 只指载荷注入实现 |
| simplified | knowledge-retrieval | 真实 grep 本地目录 + 词法排序，非 embedding 检索；使用帮助分支实际执行并检查返回记录 |
| simplified | agent | 单次模型调用，不执行自治工具循环；样本中实际执行并检查 toolsExecuted=[] |
| simplified | document-extractor | 本地文本类文件 / 支持的远程文本；不证明 PDF、Office 提取 |
| simplified | datasource / datasource-empty | 本地 JSON、JSONL、文本读取，不加载 Dify datasource 插件 |
| simplified | human-input | 从参数选择动作，或选择第一个动作；不暂停等待真人。额外真实引擎用例分别执行 approve / reject 并检查最终值 |
| placeholder | knowledge-index | 实际被调度，但不写向量库；额外用例断言最终 status=not_written、indexed=0 |
| passthrough / 非能力实现 | 未知 generic、custom-note | 未知类型仅透传并告警，note 是标注；不能视为业务节点能力 |

本组样本的某些 llm（例如 vision 配置）及 list-operator 带 field-dropped 诊断，测试保留这些诊断，不能把文本路径成功解释成图像理解或所有配置项已生效。

## 正确失败与真实路径发现

- 未声明 `missing/undeclared`：在工具 allowlist 已允许此名称时，仍经真实引擎失败，错误包含节点 `bad-tool`、完整工具名和 `not declared`，不会误用别的工具。
- 所有条件不满足：translation 的 country 非空、triage 的 priority=normal 均进入 false 分支，完成并得到预期值。
- 空 iteration：输出空数组，不报错、不启动 body 子 agent。
- code 主动抛 ValueError：`dify_native_run` 返回 status=failed、空 outputs，错误包含节点 `1732007419308` 和 `intentional e2e failure`。
- 缺必填 llm_string：run 工具返回 status=rejected，明确指出 `missing start inputs: llm_string`；按照入口协议在引擎启动前拒绝。

本次未发现 agent 签名、parallel 组合子、args 注入或 subagent provider 协议不匹配。另发现真实问题：嵌套 iteration 未被正确编译。内层容器缺少 parentId、但由外层 body 边连接时，被误判成顶层不可达节点；补齐归属后，又暴露 body emitter 把嵌套 iteration 当普通节点处理，报 `internal: no emitter for node inner (iteration)`。已修复：只对归属明确且无环的内层容器推断 owner，并递归编译容器 body。新增真实引擎回归检查两层输出 `[["a!","b!"],["c!","d!"]]`，原有 container-scope 测试不改断言并纳入总入口。修复以独立 commit `5c820c8` 提交（含真实引擎回归）。

实测还暴露外部 Jina 不可达、conversation 状态需预置、若干节点只有简化语义；这些限制不能由测试全绿抹去。

## 复现

前提：安装含上述服务的 dsh（本次版本 0.2.0-rc.2），可用的本地 sandbox 后端、Node、Python3、ripgrep，以及 Python 可导入 json_repair、requests、jieba。本机 Python 库位于 `../dsh-dify-runtime/runtime/vendor`。缺少引擎、依赖或样本会直接报错，不会跳过。测试不自动安装依赖。

```bash
cd dsh-dify-native
node tests/engine-e2e.test.mjs
# ENGINE E2E OK: 18/18 samples, 25 sample runs + negative/support cases

# 可选：保存每次样本运行的 outputs、已执行节点及支持级别
DIFY_E2E_EVIDENCE=/tmp/dify-e2e-evidence.json node tests/engine-e2e.test.mjs

./tests/run-all.sh
# ALL TESTS OK
```

默认从 PATH 的 dsh 可执行文件定位发行版，也可设置 `DSH_ENTRY=/absolute/path/to/dsh/lib/bin.js`。`DIFY_PYTHONPATH` / `DIFY_RUNTIME_PYTHON` 可指定已有 Python 环境。运行约需十几秒至几十秒；只使用回环 HTTP，不依赖公网模型或 Jina 的稳定性。

## 尚未完成

- 真实 Dify datasource 插件/其他导出参数形态未覆盖；本次仅证明样本的本地 path 契约。
- `http-request.ssl_verify`、`start.config` 尚未补齐；当前测试不能证明这些选项生效。
- 表单 conversation 变量跨 run 持久化，以及公网 Jina 部署仍需处理。
- file 输入的“multiple values for keyword argument”未复现；新增测试证明 dict 原样传入，未宣称修复该未复现错误。
- RAG 扩展按用户要求暂停。尚未合并 main 或推送远端。
