# simplified / placeholder 节点可达性实测

审计日期：2026-10-18；工作分支：`fix/semantics-gaps`。仅盘点，不修节点、不安装依赖、不修改测试。对象取自 [capability-report.md](capability-report.md) 的支持级别表，共 11 个节点名。

判据：**可实现但尚未实现的差距归 S；未安装、未配置、实现成本大都不能单独证明 C。** 下表按节点仍须补齐的、已证明可达的能力归类，不代表这个节点的所有官方模式都已证明可复刻。D 是明确降级的替代路径，不是免修 S 的理由。B 是行为偏差，不能用来收容本来能修的差距。本次没有获得足以认定整个节点客观不可实现的证据，因此没有强行填 C。也没有把探针成功当作项目已支持。

## 1. 主表

证据 E1–E6 的命令、输出和证明边界见后文；Q1 的源码及函数逐项列在第 2 节。

| 节点 | 官方依赖（指定 commit） | 本机可达性（实测证据） | 归类及理由 | 建议 |
| --- | --- | --- | --- | --- |
| trigger | 无此节点及注册项；本项目扩展入口 | E4 HTTP 收到 `topic=deploy`，返回 202；现有实现仅注入 args | **S**：实际事件接入做得到；不能声称存在 1.9.1 官方对应实现 | 定义扩展入口协议，接真实事件并保留载荷映射 |
| trigger-schedule | 无此节点；定时依赖是本地方案设计，并非官方事实 | E4 定时器实际发出 HTTP 事件；E3 croniter 及传递依赖下载成功，共 287,619 B | **S**：定时触发可达，未做调度不是资源限制 | cron、时区、持久化去重；不再固定输出 epoch 时间 |
| trigger-webhook | 无此节点；本地 HTTP listener 方案 | E4 回环 listener 实收 JSON，202；不能证明公网入站 | **S**：本机监听可达，尚未接 runner | 接 POST/body/header/query、鉴权及状态码；公网单独验证 |
| trigger-plugin | 无此节点；不能从名称反推 1.9.1 插件订阅协议 | E4 外部事件→HTTP 的机械链可达；E2 daemon 端口拒绝连接；无具体事件插件供测试 | **S**：事件桥接与显式边界诊断可做但未做；原生插件订阅仍未证实，不认定全兼容 | 明确契约桥接；不支持的原生订阅明确拒绝，另立指定插件验证任务 |
| knowledge-retrieval | SQLAlchemy/数据集元数据、Redis 条件限流、DatasetRetrieval；按模式需关键词索引或向量/embedding、可选模型路由和 rerank | E4 SQLite FTS5/BM25 实查命中；E3 rank-bm25 8,584 B 可下载；E2 常见回环向量端口未监听，未测真实 embedding | **S**：词法模式、输出形状、过滤等可补；“没有 embedding”不能否定所有检索模式 | 先补结构和词法检索；语义模式需显式 embedding 配置，不能默默用词法替代 |
| agent | PluginAgentStrategy/PluginAgentClient、策略插件、模型/工具凭据、SQLAlchemy、会话 memory、工具文件存储 | E4 两轮脚本协议实际执行一次工具并回灌结果；E6 真实引擎单轮路径通过；E2 默认 daemon 端口未监听 | **S**：循环控制和工具执行能做，当前单轮是实现缺口；指定策略插件等价性未证实 | 复用模型和工具执行器，补有界循环、取消、错误/usage；原生策略与替代策略分别声明 |
| document-extractor | **pypdfium2**、python-docx、pandas/Excel 引擎、chardet、webvtt、unstructured、Pandoc；文件管理/下载代理 | E2 fitz 1.28.0 已装；E4 真 PDF 提取成功；E3 官方版本 PDFium wheel 及 Office 库下载成功 | **S**：PDF/现代 Office 等可做；数组 text 形状也可直接修，不能归 C | 先 PDF+docx+xlsx、文件数组形状、失败语义，再覆盖其他格式 |
| datasource | DatasourceManager、凭据数据库、online-document/drive 插件、文件存储；同时有 LOCAL_FILE/WEBSITE_CRAWL 分支 | E4 文件索引读写、HTTP 实收 JSON；E6 现有本地 datasource 真引擎运行通过；E2 默认 daemon/DB 端口未监听 | **S**：本地文件和网站信息分支/文件输出可做；插件分支未部署不证明不能做 | 输出 `file`/`datasource_type`，补声明式远端适配；认证源单独验收 |
| datasource-empty | 无此官方节点及注册项；本地 `KIND_ALIASES` 映射为 datasource | E5 实际 normalize 输出 datasource；与 datasource 共用 E4/E6 文件路径能力 | **S**：别名明确，现有分派可用；“empty”的独立语义尚未定义，不能冒充官方 | 明示扩展别名和入口契约；按 datasource 补齐，不另造官方语义 |
| human-input | 无此节点及注册项；等待/恢复协议是本地方案设计 | E4 先落盘 waiting，HTTP 提交 approve，重开 SQLite 读到 resolved/approve | **S**：真实等待与落盘可达，当前默认选第一个动作是缺口 | pending→提交/超时→恢复；不得把自动首选动作说成人工确认 |
| knowledge-index | SQLAlchemy Dataset/Document/DocumentSegment、IndexProcessorFactory；**economy 用 Keyword，high_quality 用 Vector**，非一律需 embedding | E4 FTS5 真写入并关闭重开查到 2 条；E3 可下 qdrant-client；E2 未配置向量服务 | **S**：至少 economy 持久索引及正确输出完全可做，placeholder 不是 C | 补写入、更新/去重、preview、文档状态和官方输出；语义索引另外接 embedding |

**不能从这张表推出“任意 .difypkg、任意云知识库、任意账户的数据都能直接执行”。** 表中 S 的直接含义是：现有简化实现存在已经实测可达的修复项，整节点不具备 C 的免责依据。尚未证实的分支明确列为待验证，不能宣称已达 100%。

## 2. Q1：官方实现依赖什么

唯一基线：[Dify commit cd47a47c3b4acc4d4457b73777722602c33bc950](https://github.com/langgenius/dify/tree/cd47a47c3b4acc4d4457b73777722602c33bc950)。源码通过 `raw.githubusercontent.com` 下载查看；本机 `/tmp/dify-src` 的 HEAD 是另一个 commit，**没有使用那个 HEAD 作为依据**。下面路径都相对此固定基线；未混入 main 或后续版本。

### 2.1 trigger、trigger-schedule、trigger-webhook、trigger-plugin

逐一核对 `api/core/workflow/nodes/trigger/`、`trigger_schedule/`、`trigger_webhook/`、`trigger_plugin/`：均不存在。[NodeType 枚举](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/enums.py) 与 [NODE_TYPE_CLASSES_MAPPING](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/node_mapping.py) 也没有对应类型，因此 Q1 的函数名、官方核心依赖清单均为 **N/A（该版本不存在）**，不是“源码没查到所以假定等同 StartNode”。

本项目 `lib/dsl.js` 的 `compileGraph` 节点生成路径实际从 args 注入这些入口，schedule 还生成固定 `new Date(0)`。Q2 分别实测了 HTTP 事件、定时事件；plugin 名称本身不能证明插件订阅可用。Q3 可用外部 cron/事件源→声明式 HTTP→run 的桥接，但须标注本地扩展和原生订阅不兼容。

### 2.2 knowledge-retrieval

[api/core/workflow/nodes/knowledge_retrieval/knowledge_retrieval_node.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/knowledge_retrieval/knowledge_retrieval_node.py)：`KnowledgeRetrievalNode._run`、`_fetch_dataset_retriever`、`_get_metadata_filter_condition`、`_automatic_metadata_filter_func`。

- `_run` 读 StringSegment；空 query 失败；条件启用时用 Redis 做限流，SQLAlchemy 记录限流日志。
- `_fetch_dataset_retriever` 查询 Dataset/Document，调用 `DatasetRetrieval.single_retrieve` 或 `multiple_retrieve`；后者有 weighted_score/reranking_model 等配置，模型路由、embedding 和 rerank 的依赖随模式而变；外部知识库另走对应服务。不是每次都必须运行本地大模型。
- 官方输出为 `result: [{metadata, title, content}]`；metadata 包括 dataset/document 标识、score、position 等，内部数据还含 segment/child_chunks 等信息。本地 `executeKnowledge` 目前返回按 grep 行计算的词法记录，不能把 score 当官方向量分数。

Q2：E4 证明小规模关键词/BM25路径；E3 下载证明候选库可取得，**qdrant-client 是客户端，不等于向量服务已部署**。Q3：本地 FTS5/BM25，保留完整 result 外形；语义能力另报不可用。FTS5 默认分词不等于中文分词，需要现有 jieba 或显式分词策略；本次英文探针不证明中文效果。

### 2.3 agent

[api/core/workflow/nodes/agent/agent_node.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/agent/agent_node.py)：`AgentNode._run`、`_generate_agent_parameters`、`_generate_credentials`、`_fetch_model`、`_fetch_memory`、`_transform_message`。

`_run` 经 [api/factories/agent_factory.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/factories/agent_factory.py) 的 `get_plugin_agent_strategy`，使用 `PluginAgentClient.fetch_agent_strategy_provider` 查策略并构造 PluginAgentStrategy，然后 `strategy.invoke`。因此**自治循环由策略实现，不是在节点里写死的统一 ReAct 循环**。其余依赖包括模型供应商及密钥、ToolManager/工具凭据、SQLAlchemy/Conversation、TokenBufferMemory、工具文件转换与存储。

官方输出 `text`、`usage`、`files`、`json` 和策略自定义 variables；本地 `executeAgent` 的 `usage` 等需补齐，不能只靠 `output` 别名和 `json:null` 宣称形状兼容。

Q2：E4 证明循环/调用/回灌机制无硬资源障碍，模型回复是脚本，**不是实际 LLM 自治正确性测试**；E6 证明项目已有真实引擎模型调用链（固定流）。没有下载或运行具体 agent 策略包。Q3：原生有界工具循环，仅允许已声明工具，报告策略名称与替代性质；不等同运行原策略插件。

### 2.4 document-extractor

[api/core/workflow/nodes/document_extractor/node.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/document_extractor/node.py)：`DocumentExtractorNode._run`、`_extract_text_from_file`、`_download_file_content`、`_extract_text_by_file_extension` / `_extract_text_by_mime_type`。

| 官方函数 | 核心依赖 |
| --- | --- |
| `_extract_text_from_pdf` | pypdfium2.PdfDocument/textpage；**没有用 fitz、pypdf 或 pdfplumber** |
| `_extract_text_from_docx` / `parser_docx_part` | python-docx + lxml 对象，按段落/表格顺序转文本/Markdown |
| `_extract_text_from_csv` / `_extract_text_from_excel` | csv/chardet；pandas + 按格式选择的 Excel 引擎 |
| `_extract_text_from_doc` | `unstructured.partition.api.partition_via_api`，必须配置 UNSTRUCTURED_API_URL |
| `_extract_text_from_ppt` / `_extract_text_from_pptx` | unstructured，配置时走 API，否则本地 partition；旧 ppt 还涉及转换工具链 |
| `_extract_text_from_epub` | unstructured；本地分支调用 pypandoc.download_pandoc |
| `_extract_text_from_eml` / `_extract_text_from_msg` | unstructured 对应 partition；MSG 涉及其传递解析依赖 |
| `_extract_text_from_vtt` / JSON / YAML / properties / plain text 分支 | webvtt、json、yaml、chardet 及字符串处理 |
| `_download_file_content` | 远端 ssrf_proxy HTTP；本地 file_manager/存储 |

官方数组输入返回 **`text: string[]`**，单文件返回 `text: string`；错误返回 FAILED。本地总拼接成字符串并把逐文件错误放在成功结果里，属于能修的 S 语义差距。PDF 扫描件 OCR 不在上述 PDFium 文本提取逻辑内，不应凭本节点名称额外承诺。

Q2：E2/E3/E4，已装 fitz 真提取 PDF；官方固定 PDFium 版本也可下载。现代 Office 传递依赖包可下载；旧 Office/完整 unstructured 服务未运行，不能声称已验证。Q3：fitz/pypdf 提 PDF；python-docx/openpyxl 提现代 Office；ZIP/XML 可低配读主体文本但不保版式。legacy DOC/PPT 需转换器或服务，当前缺少不等于永远不可装。

### 2.5 datasource / datasource-empty

[api/core/workflow/nodes/datasource/datasource_node.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/datasource/datasource_node.py)：`DatasourceNode._run`、`_transform_message`、`_transform_datasource_file_message`、`_fetch_files`。

`_run` 读取 sys.datasource_type / sys.datasource_info，`DatasourceManager.get_datasource_runtime` 获取运行时，`DatasourceProviderService.get_datasource_credentials` 取凭据。online_document/online_drive 分别调用插件取页面/下载文件，依赖 plugin daemon、目标站网络和账户授权；LOCAL_FILE 查 UploadFile 并构造 File；WEBSITE_CRAWL 返回 datasource_info 与 datasource_type。文件依赖 storage/file_factory，元数据依赖 SQLAlchemy。

[online_document/online_document_plugin.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/datasource/online_document/online_document_plugin.py) 的 `OnlineDocumentDatasourcePlugin.get_online_document_page_content` 委托 plugin 客户端。本地 `executeDatasource` 读 records 并展开第一条字段，**不等于官方的 File/页面变量输出**。

`datasource-empty` 在指定版本的 nodes 树、枚举和映射均不存在，没有可引用的官方函数。它是本项目 `KIND_ALIASES['datasource-empty']='datasource'` 别名（E5）。Q2 对两者共同的本地文件/HTTP基础能力实测；Q3 可用已有 [声明式工具契约](dify-tool-contract.md) 的思路做数据源契约，仍需实现 datasource 专属输出转换，不是当前工具契约已经自动支持 datasource。

### 2.6 human-input

`api/core/workflow/nodes/human_input/`、NodeType 和映射无此节点，官方函数和依赖为 N/A。这里只评估项目现有承诺：真实等待、表单提交、动作分支和超时。

Q2：E4 同一 pending 记录经历创建→HTTP 回调→关闭重开数据库→resolved，证明等待状态存储和外部提交可达，未证明完整工作流 checkpoint 恢复。Q3：低配通过 pending_id + 回调接口，释放执行进程后恢复；表单可简陋，必须真的等待。当前从 args 选动作可以保留为显式自动化模式，不得默认伪装成人工完成。

### 2.7 knowledge-index

[api/core/workflow/nodes/knowledge_index/knowledge_index_node.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/knowledge_index/knowledge_index_node.py)：`KnowledgeIndexNode._run`、`_invoke_knowledge_index`、`_get_preview_output`。

`_run` 从 sys.dataset_id 查 Dataset，读取 chunks；debugger 走 preview。`_invoke_knowledge_index` 需要 sys.document_id / sys.batch，查 Document，经 IndexProcessorFactory 选择 paragraph/QA/parent-child，必要时清理旧索引，调用 `.index` 后提交 Document/DocumentSegment 状态。

关键下钻：[api/core/rag/index_processor/processor/paragraph_index_processor.py](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/rag/index_processor/processor/paragraph_index_processor.py)，`ParagraphIndexProcessor.index`：high_quality 调用 Vector，**economy 调用 Keyword**。因此“无 embedding 服务 → 整节点 C”的推理不成立。

官方非 preview 输出为 `dataset_id, dataset_name, batch, document_id, document_name, created_at, display_status`；本地 `indexed/chunks/status=not_written` 不是这个形状。preview 随 chunk_structure 格式化，不能拿一组固定键替代。Q2：E4 真写、重开可检索证明最小持久化索引可达；Q3：SQLite 维护文档、chunk、关键词和状态，语义索引另接 embedding。FTS5 是替代索引，不是 Dify 数据库兼容实现。

## 3. Q2：命令和实测记录

探测均在当前机器直接执行，未 SSH、未启动生产服务；回环服务测试结束即关闭。临时文件位于 `/tmp/reachability-audit/`，没有 `pip install`、没有修改 vendor/PYTHONPATH、package.json 或 lock 文件。下载当前可获得的候选库只证明供给；另下载官方版本约束包以区分版本兼容问题。

### E1 环境容量

```sh
nproc
python3 --version
free -b
df -B1 .
```

关键输出（瞬时值，不能与总内存混用）：

```text
2
Python 3.12.3
Mem total=3703066624 used=2843648000 free=286990336 available=859418624
Swap total=1073737728 used=0
/dev/vda1 size=42157305856 used=33153839104 available=7161454592 use=83%
```

总内存 3.45 GiB，**available 约 0.80 GiB**；磁盘可用约 6.67 GiB。E4 全部基础探针同一进程峰值 RSS 63,340 KiB（约 61.9 MiB），临时数据 33,586 B。这些小型能力已实测容纳；此数不是大数据集、完整 Dify 栈或模型的峰值。示例容量估算：10,000 个 384 维 float32 向量本体 `10000×384×4=15,360,000 B`（14.65 MiB），只说明向量本体不必占 GB，**不包含模型、索引、文本或并发内存，不是语义检索成功证据**。

### E2 已装库、可执行文件与服务

实际执行的导入探测（只读，略去第三方库内部报错堆栈）：

```sh
python3 - <<'PY'
import importlib
for n in ['fitz','pypdf','pdfplumber','docx','openpyxl','bs4','lxml',
          'sqlite3','numpy','sentence_transformers','dify_plugin',
          'onnxruntime','tokenizers','torch','transformers','pandas',
          'pypandoc','chardet','webvtt','yaml']:
    try:
        m=importlib.import_module(n)
        print(n,'OK',getattr(m,'__version__',''))
    except Exception as e:
        print(n,type(e).__name__)
PY
```

```text
fitz OK 1.28.0
sqlite3 OK
numpy OK 2.1.1
chardet OK 5.2.0
yaml OK 6.0.1
其他上述模块均 ModuleNotFoundError
```

```sh
python3 - <<'PY'
import socket,shutil
for p in [5001,5002,5432,6379,6333,8080,8890,8891]:
    s=socket.socket();s.settimeout(.3)
    print(p,s.connect_ex(('127.0.0.1',p)));s.close()
for n in ['docker','podman','go','redis-server','postgres','pandoc',
          'antiword','libreoffice','tesseract']:
    print(n,shutil.which(n))
PY
```

```text
5001 111
5002 111
5432 111
6379 111
6333 111
8080 111
8890 0
8891 0
docker None
podman None
go /home/walker/go/bin/go
redis-server None
postgres None
pandoc None
antiword None
libreoffice None
tesseract None
```

111 是 ECONNREFUSED，0 是连接成功；只代表这些回环端口，无从排除其他端口或远端服务。环境存在 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，Python/curl 下载成功；未把代理成功等同于 Node fetch 自动代理成功。未读取/记录密钥值，未向实际模型或第三方账户发收费请求；embedding 服务、目标知识库和插件订阅未做端到端证明。

### E3 下载大小（只评估，不安装）

实际命令：

```sh
mkdir -p /tmp/reachability-audit/wheels
python3 -m pip download --no-deps --dest /tmp/reachability-audit/wheels \
  pypdf python-docx openpyxl rank-bm25 croniter qdrant-client dify-plugin
python3 -m pip download --dest /tmp/reachability-audit/office \
  python-docx openpyxl croniter
python3 -m pip download --no-deps --dest /tmp/reachability-audit/wheels \
  onnxruntime pypdfium2
python3 -m pip download --no-deps --dest /tmp/reachability-audit/extra \
  pandas unstructured python-pptx extract-msg xlrd webvtt-py pypandoc sqlalchemy redis
python3 -m pip download --no-deps --dest /tmp/reachability-audit/official \
  'pypdfium2==4.30.0' 'python-docx~=1.1.0' 'pandas~=2.2.2' \
  'unstructured~=0.16.1' 'webvtt-py~=0.5.1' 'sqlalchemy~=2.0.29' 'redis~=6.1.0'
```

前三条输出均有 `Successfully downloaded ...`。文件大小用 `Path.stat().st_size` 实测：

| 候选 wheel | 下载 B（不是安装大小） | 解释 |
| --- | ---: | --- |
| pypdf 6.21.1 | 405,134 | 395.6 KiB，纯 Python PDF 替代 |
| python-docx 1.2.0 | 252,987 | 还要 lxml/typing_extensions |
| openpyxl 3.1.5 | 250,910 | 还要 et-xmlfile |
| rank-bm25 0.2.2 | 8,584 | 依赖 numpy；本机已装 numpy |
| croniter 6.2.4 | 46,677 | 加 python-dateutil 229,892 B、six 11,050 B |
| qdrant-client 1.19.1 | 406,533 | 未下载其完整依赖；不是 Qdrant server |
| dify-plugin 0.10.2 | 379,282 | Python SDK，不是 Go daemon，不能据此宣称支持 difypkg |
| onnxruntime 1.31.0 cp312 x86_64 | 23,760,984 | 仅推理运行库；无模型/tokenizer，**未验证 embedding** |
| pypdfium2 5.14.0 x86_64 | 3,799,581 | 候选版本，不冒充官方锁定版本 |

`office/` 完整解析下载另含 lxml 6.1.3（5,244,675 B）、typing_extensions（45,571 B）、et_xmlfile（18,059 B）、dateutil/six；连三个顶层包共 **6,099,821 B**。其中 docx 闭包 5,543,233 B（5.29 MiB），xlsx 闭包 268,969 B，croniter 闭包 287,619 B。安装解压大小、传递版本兼容和极端文件处理仍需下一轮验证；本工单没有运行新下载包。

官方 `api/pyproject.toml` 约束下的下载也全部成功（`Successfully downloaded pypdfium2 python-docx pandas unstructured webvtt-py sqlalchemy redis`）：

| 官方约束 → 实际解析版本 | wheel B |
| --- | ---: |
| pypdfium2==4.30.0 | 2,812,008 |
| python-docx~=1.1.0 → 1.1.2 | 244,315 |
| pandas~=2.2.2 → 2.2.3 | 12,739,445 |
| unstructured~=0.16.1 → 0.16.25 | 1,769,286 |
| webvtt-py~=0.5.1 → 0.5.1 | 19,802 |
| sqlalchemy~=2.0.29 → 2.0.55 | 3,473,971 |
| redis~=6.1.0 → 6.1.1 | 273,930 |

这是 pyproject 范围解析，**不是 uv.lock 全环境复原**；unstructured 未带 extras/传递依赖，redis Python 客户端也不是服务端。额外候选下载全部成功：python-pptx 1.0.2 为 472,788 B，extract-msg 0.56.1 为 337,639 B，xlrd 2.0.2 为 96,555 B，pypandoc 1.17 为 23,554 B；后者不含 Pandoc 二进制。未因这些小 wheel 就断言旧 Office 转换链已可用。

### E4 实际能力探针

实际执行：`python3 /tmp/reachability-audit/probe.py`。完整源码如下，可复制到临时目录执行；只导入标准库和**原已安装**的 fitz，不导入新下载包。脚本模型回复只验证控制机械路径，HTTP仅回环，DOCX是主体 XML 容器探针。三个边界均不能外推成产品完成。

```python
import fitz, sqlite3, tempfile, pathlib, json, threading, http.server
import urllib.request, resource, zipfile, io, xml.etree.ElementTree as ET
import shutil
root = pathlib.Path(tempfile.mkdtemp(prefix='reachability-probe-'))
pdf = fitz.open()
page = pdf.new_page()
page.insert_text((72, 72), 'reachability PDF OK')
pdf.save(root / 'probe.pdf')
pdf.close()
with fitz.open(root / 'probe.pdf') as doc:
    print('PDF:', doc[0].get_text().strip())

db = sqlite3.connect(root / 'state.db')
db.execute('create virtual table chunks using fts5(dataset_id UNINDEXED,content)')
db.executemany('insert into chunks values (?,?)',
               [('a', 'refund payment pending'), ('b', 'weather today')])
db.commit()
print('FTS5:', db.execute("select dataset_id,content from chunks "
                         "where chunks match 'refund' order by bm25(chunks)").fetchall())
db.close()
db = sqlite3.connect(root / 'state.db')
print('INDEX reopen:', db.execute('select count(*) from chunks').fetchone()[0])
db.execute('create table pending(id text primary key,status text,action text)')
db.execute("insert into pending values ('h1','waiting',null)")
db.commit()
db.close()
events = []
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        events.append(data)
        if 'action' in data:
            conn = sqlite3.connect(root / 'state.db')
            conn.execute("update pending set status='resolved',action=? where id='h1'",
                         (data['action'],))
            conn.commit()
            conn.close()
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b'{"accepted":true}')
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), H)
thread = threading.Thread(target=server.serve_forever)
thread.start()
url = 'http://127.0.0.1:' + str(server.server_port)
def post(data):
    req = urllib.request.Request(url, json.dumps(data).encode(),
                                 {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return r.status
print('WEBHOOK:', post({'topic': 'deploy'}), events[-1])
timer = threading.Timer(.05, lambda: post({'scheduled': True}))
timer.start()
timer.join()
print('SCHEDULE fired:', events[-1])
print('HUMAN callback:', post({'action': 'approve'}))
conn = sqlite3.connect(root / 'state.db')
print('HUMAN reopen:', conn.execute('select status,action from pending').fetchone())
conn.close()
server.shutdown()
thread.join()
server.server_close()
messages = []
calls = 0
for reply in [{'tool': 'sum', 'args': [2, 3]}, {'final': '5'}]:
    if 'tool' in reply:
        messages.append({'tool_result': sum(reply['args'])})
        calls += 1
    else:
        print('AGENT protocol:', {'turns': 2, 'tool_calls': calls,
                                  'result': reply['final'], 'history': messages})
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as z:
    z.writestr('word/document.xml',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body><w:p><w:r><w:t>Office OK</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as z:
    print('DOCX XML:', ''.join(ET.fromstring(z.read('word/document.xml')).itertext()))
print('maxrss KiB:', resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
print('TEMP bytes:', sum(p.stat().st_size for p in root.iterdir()))
shutil.rmtree(root)
```

实测输出（上面做了排版和显式关闭 SQLite 连接，原探针的能力步骤相同）：

```text
PDF: reachability PDF OK
FTS5: [('a', 'refund payment pending')]
INDEX reopen: 2
WEBHOOK: 202 {'topic': 'deploy'}
SCHEDULE fired: {'scheduled': True}
HUMAN callback: 202
HUMAN reopen: ('resolved', 'approve')
AGENT protocol: {'turns': 2, 'tool_calls': 1, 'result': '5', 'history': [{'tool_result': 5}]}
DOCX XML: Office OK
maxrss KiB: 63340
TEMP bytes: 33586
```

这不是 Dify 节点集成测试：没有 runner checkpoint、多 worker 抢占、cron 时区/DST、真实工具选择、OAuth 刷新等。它足以否定“基础能力因本机资源客观无法实现”的结论，但不能证明这些产品边界已完成。

### E5 版本存在性与本地别名

实际执行：

```sh
git -C /tmp/dify-src ls-tree -d --name-only \
  cd47a47c3b4acc4d4457b73777722602c33bc950 api/core/workflow/nodes/
node --input-type=module - <<'JS'
import {normalizeKind} from './lib/dsl.js';
for (const k of ['trigger','trigger-schedule','trigger-webhook','trigger-plugin',
                 'datasource','datasource-empty','human-input'])
  console.log(k,'=>',normalizeKind(k));
JS
```

固定 tree 的节点目录输出包含 agent、datasource、document_extractor、knowledge_index、knowledge_retrieval 等，**不含任何 trigger、human_input 或 datasource_empty 目录**。另核对同一 commit 的 workflow/enums.py 和 nodes/node_mapping.py，没有对应类型/注册。对应的官方依赖无法凭空给出；Q1 的不存在结论也是实测结果。

本地输出：

```text
trigger => trigger
trigger-schedule => trigger-schedule
trigger-webhook => trigger-webhook
trigger-plugin => trigger-plugin
datasource => datasource
datasource-empty => datasource
human-input => human-input
```

获取官方文件的可复现方法（本次使用 Python urllib 等价串行下载）：

```sh
curl -fL --max-time 30 \
  https://raw.githubusercontent.com/langgenius/dify/cd47a47c3b4acc4d4457b73777722602c33bc950/api/core/workflow/nodes/document_extractor/node.py \
  -o /tmp/reachability-official-check.py
wc -c /tmp/reachability-official-check.py
# 26273 /tmp/reachability-official-check.py
```

### E6 项目回归

实际执行 `./tests/run-all.sh > /tmp/reachability-audit/tests.log 2>&1`，exit code **0**。末尾：

```text
ENGINE E2E OK: 18/18 samples, 25 sample runs + negative/support cases
== tests/engine-nested.test.mjs
NESTED ENGINE E2E OK: explicit and inferred container ownership
ALL TESTS OK
```

未改断言、未跳过失败。模型使用既有固定流；通过结果不证明外部模型、Jina、原生插件或本报告提出的新实现已经可用。

## 4. S 类清单：按价值/成本排序

以下是下一轮建议，**本次未实施**。行数为阅读现有文件后的工程估算，含新增实现，不是已经测量的 diff；配套测试只估范围。全部优先保正确输出形状/错误，质量可以逐步增强。所有外部配置缺失都应明确失败或显式降级，不能虚报执行。

| 顺序 / 节点 | 要做什么 | 需要安装什么（本次下载大小） | 预计改动范围 | 现有测试风险 |
| --- | --- | --- | --- | --- |
| 1 document-extractor | PDF+docx+xlsx；数组 text 保持数组；文件错误按官方失败 | PDF 用已装 fitz：0；docx 及闭包约 5.29 MiB；xlsx 闭包 268,969 B；也可选官方 PDFium 2,812,008 B | `lib/provider.js` 约 120–220 行，`lib/dsl.js` 约 10–30 行；若隔离 Python helper 再约 80–150 行 | 单文件样本可保留；数组拼接和部分失败成功的旧断言需按官方改；远程二进制必须走 bytes，不可 UTF-8 解码 |
| 2 knowledge-retrieval | 补 result 的 metadata/title/content、分块、过滤/top_k；明确词法模式；BM25 替代当前按行命中比例 | SQLite 标准库 0；rank-bm25 可选 8,584 B（numpy 已装） | `lib/provider.js` 约 120–220 行，`lib/dsl.js` 约 30–60 行 | intent-reply 仍应命中；分数/排序改变不能沿用向量阈值；中文需另验 |
| 3 knowledge-index | 先 economy 真落盘、查询互通、幂等更新、空 chunks 失败、preview；补官方输出键与文档状态 | SQLite 0；embedding 不作为 economy 前置 | `lib/provider.js` 约 180–300 行，`lib/dsl.js` 约 40–80 行，索引 helper 可拆约 100–180 行 | 既有 `status=not_written/indexed=0` 是 placeholder 断言，修复时必须有计划更新并验证新写入；不得为了留绿继续占位 |
| 4 datasource / datasource-empty | 补本地 File 及 datasource_type、网站信息形状；明确 empty 是扩展别名 | 本地/HTTP 0；云源按具体 API/OAuth 再评估 | `lib/provider.js` 约 100–180 行，`lib/dsl.js` 约 30–60 行 | records 样本当前是本地扩展协议，宜显式模式兼容；不能擅自删除已承诺字段 |
| 5 agent | 有界 tool loop、工具白名单/参数校验/回灌、取消、usage/json/files；区分原策略和原生替代策略 | 复用现有 LLM/tool 执行器，新增包 0；第三方策略运行不是装 SDK 即完成 | `lib/provider.js` 约 200–350 行，`lib/dsl.js` 约 40–80 行；复用 `lib/tool-contracts.js` | 既有单轮样本须继续可无工具完成；新增真实工具调用测试；严防重复副作用和无限循环 |
| 6 trigger / trigger-webhook | listener→真实启动 workflow；payload、header/query、状态码、鉴权和去重 | Node HTTP 标准库 0 | `lib/index.js` 约 100–180 行，`lib/event-runtime.js`（建议新增） 约 50–100 行，`lib/dsl.js` 约 30–60 行 | 当前事件注入测试应保留为显式注入路径；端口占用/并发生命周期需新验；公网未证明 |
| 7 trigger-schedule | cron/时区、真实触发时间、重启补偿/去重；复用上项入口 | 简单定时器 0；croniter 闭包 287,619 B；不能拿 timer 探针宣称 cron 全兼容 | `lib/index.js` 约 80–140 行，`lib/event-runtime.js`（建议新增） 约 30–60 行，`lib/dsl.js` 约 20–40 行 | 固定 epoch 的断言应更正；测试应注入时钟并控制定时器清理 |
| 8 human-input | pending_id、表单提交、超时、持久 checkpoint/恢复；自动模式须 opt-in | SQLite/HTTP 0 | `lib/event-runtime.js`（建议新增） 约 200–400 行，`lib/provider.js` 约 80–150 行，`lib/dsl.js` 约 50–100 行，`lib/index.js` 约 50–100 行 | 当前 approve/reject args 用例是自动模式，不是真等待；恢复不得重跑上游副作用，跨容器较高风险 |
| 9 trigger-plugin | 先声明式事件桥接、签名/参数映射、订阅能力诊断；指定包后再评估原生 daemon | 桥接 0；SDK 379,282 B 不能替代 daemon，完整插件依赖大小未测 | `lib/index.js` / `lib/event-runtime.js`（建议新增） 约 120–240 行，`lib/dsl.js` 约 30–60 行 | 原生订阅无基线样本；不能按插件名称猜事件语义；桥接不得宣称执行 difypkg |

依赖若在下一轮获准安装，沿用现有 `vendor/` + PYTHONPATH 机制。**这里的 0 只指新增包，不是开发成本或服务费用为零。** 原生插件、真实 embedding、旧 Office 完整工具链仍需要专门验收，不在上述行数中偷算成已完成。

## 5. C 类清单：真做不到的证据

**本次确认的整节点 C：0 项。** 这不等于确认全部原生分支可达，只是没有取得“客观不可能”的充分证据。下面是确实存在的部署阻塞及可复核范围，不能拿它们扩大成整节点 C：

| 受阻目标 | 实测卡点 | 为什么不足以判整个节点 C / 下一步如何验证 |
| --- | --- | --- |
| 直接加载任意 `.difypkg` 的 agent/datasource 或插件订阅 | E2 无 docker/podman，5001/5002/5432/6379 均拒绝连接；未提供具体插件包和账户 | 证明当前链不通，没证明 Go daemon/精简后端不可安装。本机还有 Go；不能编造最低内存。需指定插件、版本、账户和启动形态，测镜像/环境落盘及实际 RSS 后才可认定资源不足 |
| 直接用现有 Dify 数据集 ID 访问其文档、凭据、索引 | 没有配置源 Dify 的 DB/API/凭据映射；本地 ID 只是目录 | 无法从 ID 还原数据，不得捏造；但可导入数据或配置源服务。这是配置/数据来源阻塞，economy 本地写入已经成功 |
| 与指定 embedding/reranker 输出和分数完全一致 | E2 常见本地模型栈缺失、6333 无服务；只下载了 ONNX runtime，未测模型/endpoint | 没有来源可测，因此不报“语义检索已可用”；也不能据此说小模型或远端 API 一定不可用。需指定模型、下载权重/实测推理及内存、维度/阈值与服务连通性 |
| 原官方旧 DOC/PPT/EPUB 完整转换链 | E2 缺 Pandoc/LibreOffice/antiword；没有 UNSTRUCTURED_API_URL；E3 仅基础 wheel | 当前缺依赖，不是安装不可行的证据；需测转换器二进制/服务及真实样本。不能把现代 Office 可达外推成 legacy 格式全通 |
| 公网 webhook 入站/云源授权 | E4 只成功回环；未配置公网地址、反代或特定云账户 | 不是本地 listener 做不到；需由真实外部源请求目标入口并验签/返回。没测过就不宣称公网成功 |

资源证据补充：[固定版本 docker/docker-compose.yaml](https://github.com/langgenius/dify/blob/cd47a47c3b4acc4d4457b73777722602c33bc950/docker/docker-compose.yaml) 中 plugin_daemon 使用 `langgenius/dify-plugin-daemon:0.3.0-local`，连接 db，并配置 `DIFY_INNER_API_URL=http://api:5001`；API/worker 另需 Redis/DB 等。但该 daemon 配置**没有提供可直接用来证明本机不够的内存下限**。没有拉取镜像、没有搭全栈，也没有测峰值，故不写“最低 X GB > 可用 Y GB，所以 C”。工单给的 `.difypkg` 示例不能代替本次测量。

如必须按任意原生插件的 100% 兼容性验收，当前结论是**尚未证实可达性**，不是已验收，也不是有证据的 C。它不消除第 4 节已经证明能做的 S 项。

## 6. 冒充方案清单（D：显式降级方案）

本节 D 指方案降级性质，主表仍按可修的差距记 S，**不为同一节点给第二个主归类**。未测业务语料/真实插件，不能虚构“达到 80%”百分比；以下给出可核对的功能覆盖及损失。`diagnostics` 代码是建议协议，本次未添加实现。必须进入 inspect 与运行结果可见的诊断，不能只留代码注释或只有开发者能看到的 meta。

| 方案 / 重度 | 能到什么程度 / 缺什么 | 代价 | 建议 diagnostics（至少 severity、code、节点、模式、边界） |
| --- | --- | --- | --- |
| FTS5/BM25 检索 / **重** | 真检索、分块、过滤、top_k、可持久化；不懂同义改写/语义，不含 reranker；英文探针已过，中文待分词验证 | 新依赖 0 或 8.4 KiB rank-bm25；索引随文本增长 | `warning: retrieval.lexical-only`；`mode=bm25, semantic=false, rerank=false`；“当前为非语义检索，分数与向量阈值不等价” |
| SQLite economy 索引 / **重**（相对 high_quality） | 真写入、状态、更新/查回；不创建语义向量，不同步远端 Dify 数据库 | 标准库 0；需文档/segment 元数据与迁移 | `warning: index.local-keyword-only`；`embedding=false, remote_sync=false`；仅提交事务后可报 written，placeholder 不得报完成 |
| fitz/pypdf PDF、python-docx/openpyxl Office / **中** | 文本型 PDF/段落/表格数据可提；换引擎可能改变换行顺序，版式/公式等不保证；扫描 PDF 不保证 OCR | fitz 已装；PDF 替代 395.6 KiB 或 Office 闭包约 5.54 MiB（docx+xlsx） | `warning: extraction.alternative-engine`；列出 engine、格式、`ocr=false`；真错误为 error，截断须另发 `extraction.truncated`，不能把二进制当文本 |
| ZIP/XML 读 docx/pptx/epub 主体 / **重** | E4 只证实 DOCX 主体 XML 文本；可设计提取现代 ZIP 容器文本，但表格/顺序/关系/脚注可能丢失，其他格式未运行 | 标准库 0，处理 XML 安全限制/解压上限 | `warning: extraction.body-text-only`；逐文件报告遗漏部件；不宣称完整 Office |
| 原生有界 agent loop / **重**（相对策略插件） | 可执行已声明工具并回灌；不能保证原策略提示、规划/日志/模型特性等价；E4 不是活模型验收 | 无新增包；模型轮次和真实工具可能增加费用 | `warning: agent.strategy-emulated`；`requested_strategy=…, engine=native-bounded-loop, max_turns=…`；达到上限须明确错误/终止原因 |
| HTTP datasource 契约 / **重**（相对原插件） | 可复现已声明页面/API/文件下载；OAuth刷新、分页和云权限需逐源实现，未知源拒绝 | 无新增包；需要真实 URL/授权，网络依赖仍在 | `warning: datasource.contract-adapter`；列出 source/支持操作/不支持认证；不得记录 secret |
| cron/webhook/plugin 事件桥 / **重**（原生 plugin）；**中**（本地调度/HTTP） | 事件到达后能启动入口；不执行 Dify 插件订阅生命周期，不含自动公网暴露/分布式 exactly-once | 标准库 0；croniter 可选约 281 KiB 闭包；需常驻进程/去重 | `warning: trigger.external-bridge`，`native_plugin_subscription=false`；另外 `warning: baseline.node-not-in-dify-1.9.1`，不能伪造官方语义 |
| pending_id + 简陋回调表单 / **中** | 真等真人、超时、显式动作；UI、通知、权限体验可能简陋；E4 只证明状态机制，工作流恢复未做 | SQLite/HTTP 0；checkpoint 集成成本较高 | `info: human.pending`（等待态不能标 succeeded）；自动模式另发 `warning: human.auto-resolved`，列出动作来源，默认不能自动批准 |
| datasource-empty 显式别名 / **中** | 与 datasource 的本地契约共用实现；不存在本次可核对的官方 empty 语义 | 0 | `warning: datasource.alias-extension`，`alias=datasource-empty, resolved=datasource`；配合 baseline 不存在诊断 |

任何 fallback 都要显式配置或节点诊断。能修的输出形状、缺失字段、真假成功和错误传播不属于允许随意降级的内部质量；不得用“麻雀”掩盖它们。

## 7. 本次交付边界

仅新增本文件；源码、测试、依赖声明和 vendor 均未修改。工作区原有的 vendor/jieba、runs、tools 等未跟踪内容保留原样，不纳入提交。临时下载未装入运行环境；全量测试 exit 0、`ALL TESTS OK`。修复优先级与诊断方案供下一轮实施，不构成本轮已完成能力的承诺。

## 2026-10-18 修复状态（以上为 b6f3436 的历史证据）

#1 基础项已修但整组仍有 S 子项：数组/单文件形状、任一文件失败、完整文本、远程 bytes 已验证。02d4101 的手写 OOXML 与 fitz 方案被纠正：使用 pypdfium2==4.30.0、python-docx、pandas/openpyxl，以及固定 cd47a47 纯函数，DOCX 表格/换行、YAML/properties/VTT/CSV/JSON 转换、Excel 多 sheet/数字/公式缓存逐字对标。AST 参考源码保存于 tests/fixtures/dify-cd47a47-document-extractor.py，真实差分回归 tests/engine-extraction-differential.test.mjs。初次差分实际失败：PDF 多一个换行；修复后 8 种格式逐字通过。依赖安装、S 余项及边界见 capability-report 的 Extraction 修正段；未因现代 Office 成功宣称旧格式完成。

TLS 4651731 已复核；start.config 在固定版本不存在，不凭空实现。#2/#3 RAG 继续按用户要求暂停。

#4 基础项已修（2 个节点名）：系统变量、File/网站形状、独立声明式远端协议与插件边界；JSONL 吞错修复。原生 datasource 插件/认证源/文件存储仍 S 子项，见 datasource-contract.md，未标全兼容。

#5 agent 基础循环已修，但原生策略插件、文件流、完整计费 usage、memory 等价仍 S 子项；不可把本地策略宣称全兼容。真实引擎证据见 engine-agent-loop.test.mjs 和 agent-strategy.md。

额外 conversation 真问题已修：同会话跨 run 持久变量与隔离由 engine-conversation.test.mjs 验证；失败/崩溃期间的逐节点提交边界仍为 S 子项，未宣称完整 Dify DB 等价。

#6 两节点与 #9 一节点：HTTP listener、鉴权/载荷映射、持久去重及显式签名插件桥已修；真实引擎测试 engine-events.test.mjs。新增节点参考另固定 5dff246，路径/函数与 S 边界见 event-deployment.md，未改写历史 Q1。原生订阅/文件/公网未验仍 S。

#7 基础项已修：cron/时区/真实槽时间/持久补偿去重；engine-schedule.test.mjs 先失败缺调度入口，修后真实引擎通过。visual_config 四种频率及 last 已补，固定新版纯函数复用且真实引擎通过；原生服务生命周期未验证仍 S。

#8 顶层真实等待/持久 checkpoint/提交/超时恢复已修；取消默认首选动作，保留显式注入。engine-human-wait.test.mjs 验证重开后恢复且上游 HTTP 不重放，等待时误新 run 明确拒绝；engine-human-form.test.mjs 验证动态内容/默认变量。容器内暂停、高级表单、自动过期通知及原生生命周期仍 S 子项。另修普通 HTTP 错误 guard 跳过下游：真实失败回归 engine-http-follow.test.mjs 已通过。
