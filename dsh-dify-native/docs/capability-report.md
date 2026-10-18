# 当前执行能力与语义余项

**限定协议下可以用，整体语义收尾尚未全部完成。非 RAG 仍有 23 个离散 S 子项：17 项可继续本地开发/依赖配置，6 项须有指定真实插件、账户或 Dify 部署资料验收。** 原审计 7 个非暂停组（9 个节点名）仍含 21 项，另有 conversation、HTTP 阶段 timeout 各 1 项；[逐项清单与验收条件](semantic-gaps.md) 是计数依据。RAG 的 #2 knowledge-retrieval / #3 knowledge-index 两组、两个节点名按用户要求暂停，未混入 23 项。

全量验证：`./tests/run-all.sh` 的 34 个入口全部通过（`ALL TESTS OK`）。18 个真实样本经 `workflowEngine.start` 全链路执行并断言最终 outputs。

每个节点都在 `dify_native_inspect` 上报出与 Dify 的偏离项（`deviations`），按危险度分档：**跑成功但做了别的事**（`semantics-differ`）、**降级实现**（`semantics-degraded`）、**完全不支持**（`node-unsupported`）。支持级别由这些缺口与字段丢弃共同推导；`full` 只表示"未检测到本图特有的降级原因"。

## 当前范围（按审计分组）

| 组 | 节点名 | 已实现且真实验证 | 未完成 S 子项数 |
| --- | --- | --- | --- |
| #1 | document-extractor | 固定官方 PDFium 4.30.0 / python-docx / pandas+openpyxl；合法文件逐字差分；完整扩展名/MIME 路由；数组、远端 bytes、任一失败即失败 | 7（EX1–EX7） |
| #4 | datasource / datasource-empty | sys.datasource_type/info 真注入；File/网站输出；独立声明式 HTTP 适配；显式 local/file records 保留 | 2（DS1–DS2） |
| #5 | agent | 显式 dsh-bounded-tools 有界工具循环、工具白名单/schema、结果回灌、重复 id/上限/取消；token usage、json[]、files[] 形状 | 4（AG1–AG4） |
| #6 | trigger / trigger-webhook | 声明式实际 HTTP listener → runner → 引擎；载荷/header/query 映射、鉴权、状态码、持久去重、sys.* 输出 | 2（WH1–WH2） |
| #7 | trigger-schedule | croniter cron/IANA 时区；固定新版 visual 四种频率/last 转换；真实槽时间、去重、重启补偿 | 1（SC1） |
| #8 | human-input | 顶层 waiting/checkpoint、动态表单/默认变量、显式提交/到期恢复；重开与重送不重放上游；保留显式 action 注入 | 4（HU1–HU4） |
| #9 | trigger-plugin | 明确 bridge:true 的 HMAC 签名 HTTP 桥、显式参数映射、订阅能力诊断；不执行原生订阅 | 1（TP1） |
| 审计外 | conversation / http-request | 同会话同工作流跨 run 状态与会话隔离；TLS false/true/缺省/null；普通 HTTP 后继与官方 timeout 键 | 2（CV1、HT1） |

上述为有限实现，inspect 对 agent/文档/datasource/human/trigger* 保留 simplified；HTTP 分阶段 timeout 配置也报告简化。full 只表示特定已实现字段范围，没有“Dify 全兼容”的含义。未知节点仍可见 passthrough；不计成业务能力。RAG 的检索仍是词法实现、索引仍是 placeholder。

## 官方依据与部署

基线为 [cd47a47c3b4acc4d4457b73777722602c33bc950](https://github.com/langgenius/dify/tree/cd47a47c3b4acc4d4457b73777722602c33bc950)：

- `api/core/workflow/nodes/document_extractor/node.py`：`DocumentExtractorNode._run`、`_extract_text_from_file`、两个完整路由及各纯提取函数。扩展名优先，缺扩展才看 MIME；`.vtt` 为原文，MIME-only text/vtt 才转换。未知/缺转换链明确失败，不用缩减表猜 MIME。49 个官方纯文本扩展及 8 个 MIME-only 格式已参数化验证。
- `api/core/workflow/nodes/datasource/datasource_node.py`：`_run`、`_transform_message`、`_transform_datasource_file_message`，以及 `api/core/workflow/nodes/agent/agent_node.py` 的 `_run` / `_transform_message` 和 `api/factories/agent_factory.py:get_plugin_agent_strategy`。
- `api/core/workflow/nodes/http_request/entities.py:HttpRequestNodeTimeout` 与 `api/core/helper/ssrf_proxy.py:make_request/_get_ssrf_client`。start.config 在固定基线不存在，不凭名称赋予语义。

该基线没有 trigger* / human-input。新增节点另固定 [5dff24671d7eb0db087a01b699444d2f1939f17e](https://github.com/langgenius/dify/tree/5dff24671d7eb0db087a01b699444d2f1939f17e)，具体路径/函数见 [事件部署](event-deployment.md) 与 [人工等待](human-wait.md)。普通 trigger、datasource-empty 是本地扩展/别名，没有伪造官方独立节点。

[部署说明](deployment.md) 给出 npm ci/pack、直接声明的 nunjucks/yaml/ajv、Python 固定依赖与新目录安装步骤；不覆盖原 vendor/config。支持 `DIFY_RUNTIME_PYTHON`、`DIFY_PYTHONPATH`、`DIFY_EXTRACTION_VENDOR`、`DIFY_EVENTS_VENDOR`。缺库明确给安装方法，运行时不隐式安装。未装 unstructured。提取子进程输出超过 4 MiB 明确失败，不静默截断；不承诺 OCR。

其他协议：[datasource](datasource-contract.md)、[agent 替代策略](agent-strategy.md)、[工具契约](dify-tool-contract.md)、[控制流](control-semantics.md)。本地 HTTP fixture 证明协议/实际 I/O，不能代替真实云账户、Jina 或原生插件验收。

## 验证文件与关键证据

新能力均经 `tests/helpers/real-harness.mjs` 装载已安装 dsh，实际 `workflowEngine.start → PTC 子进程 → dify-node → sandbox/HTTP/tools/Python → outputs`。只允许 LLM 固定回复，没有 mock 引擎。打包测试只验证独立安装/import/helper，核心 E2E 仍用真实引擎。

| 测试文件（tests/ 下） | 关键断言 / 输出 |
| --- | --- |
| engine-extraction.test.mjs | 数组含空元素、完整 2,010,000 字符、合法 PDF/Office、远程 PDF bytes、404/二进制/混合文件失败 |
| engine-extraction-differential.test.mjs | AST 从固定官方源码同时加载真实路由和纯函数，8 格式输出逐字相等；合法 DOCX 混合段落表格、XLSX 多 sheet/数字/空行/换行/公式缓存 |
| engine-extraction-routing.test.mjs | `49 official plain extensions + 8 MIME routes`；.vtt 原文、MIME-only 转换、远端无扩展 MIME、扩展优先、混合失败 |
| engine-datasource.test.mjs | sys 注入、file/website 形状、实际远端契约请求、插件路径拒绝、损坏 JSONL 失败 |
| engine-agent-loop.test.mjs | 实际 HTTP 工具一次，第二轮模型看到结果；usage.total_tokens=10；未声明/schema/duplicate/limit/cancel 失败 |
| engine-conversation.test.mjs | 同会话第二次 n=2，不同会话 n=1 |
| engine-events.test.mjs | 真实 listener、header/query/body 输出、鉴权401、重送 duplicate、HMAC 插件桥、sys.* 与 simplified 诊断 |
| engine-schedule.test.mjs / engine-schedule-visual.test.mjs | 上海09:00=UTC01:00、重启补偿/去重；hourly/daily/weekly/monthly-last 四模式真实输出 |
| engine-human-wait.test.mjs / engine-human-form.test.mjs | waiting→重开→提交→正确分支；重复/误新 run 不重放，上游 HTTP 只一次；动态表单及变量默认值逐字相等；到期分支 |
| engine-http-follow.test.mjs | 普通 HTTP 成功响应进入下游节点 |
| engine-http-tls.test.mjs / engine-http-timeout.test.mjs | 自签证书 false 成功，true/缺省失败，null 明确错；connect/read/write=1 后真实延迟端点走 timeout 分支 |
| package-deployment.test.mjs | 临时 npm pack/独立 npm install；`CLEAN PACKAGE IMPORT OK`；打包文件齐全，PDF/cron helper 用显式依赖路径可用 |
| engine-e2e.test.mjs / engine-nested.test.mjs | 18/18 样本输出、错误/支持分支、显式与推断的嵌套容器 |

复现 `./tests/run-all.sh`（34 个测试入口）。需已装 dsh/可用 sandbox、Node/Python、既有样本依赖，以及提取/cron 的显式依赖；package-deployment 需要 npm registry 网络。任何缺失/失败均退出失败，不 skip、不吞错。测试采用本地回环服务，无付费模型请求。

未验证范围：公网入站、真实公网 Jina、真实模型自治质量、全部时区/DST 组合、断电恢复。本地去重采用先 claimed 后执行、中断不自动重放，不承诺分布式 exactly-once。语义缺口见 [23 项 S 清单](semantic-gaps.md)。
