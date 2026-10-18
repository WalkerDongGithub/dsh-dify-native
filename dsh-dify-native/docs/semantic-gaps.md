# 当前 S 余项（2026-10-18）

**非 RAG 共 23 个离散 S 验收子项：17 项可继续本地开发/配置依赖，6 项验收须有指定插件、账户或 Dify 部署资料。** 其中原审计的 7 个非暂停分组、9 个节点名仍含 21 项；审计外 conversation/HTTP timeout 各 1 项。分组数、节点数、子项数不是同一个口径。以下缺口仍是 S，未因缺服务、缺配置或未验证而改成 C/D。

L 表示仍欠本地实现/第三方依赖/回归；E 表示缺少明确的真实目标资料且原生路径未完成。E 并非做不到，也不等于桥接已证明原生能力。这份清单意味着语义收尾尚未全部完成。

| ID | 审计组 | 节点名 | 类别 | 尚欠能力 | 离散验收条件 / 需要的资料 |
| --- | --- | --- | --- | --- | --- |
| EX1 | #1 | document-extractor | L | DOC 转换链 | 合法 .doc 通过固定官方路由提取文本；服务/转换器错误使节点失败。 |
| EX2 | #1 | document-extractor | L | 旧 PPT 转换链 | 合法 .ppt 对标官方文本输出，不能按 ZIP/XML 或文本猜读。 |
| EX3 | #1 | document-extractor | L | PPTX 官方转换链 | 合法多 slide/文本框 fixture 与官方 partition 路径比较；当前明确拒绝。 |
| EX4 | #1 | document-extractor | L | EPUB 转换链 | 含章节/目录的合法 EPUB 经显式依赖提取；不得隐式下载 Pandoc。 |
| EX5 | #1 | document-extractor | L | EML 转换链 | 合法邮件及附件 fixture 对标官方 partition_eml；当前明确拒绝。 |
| EX6 | #1 | document-extractor | L | MSG 转换链 | 合法 MSG 对标官方 partition_msg；缺库/损坏文件明确失败。 |
| EX7 | #1 | document-extractor | L | XLS 专用引擎及回归 | 配置 xlrd 等轻量依赖，真实 .xls 多 sheet 与官方 pandas 结果一致；当前 requirements 未含专用引擎。 |
| DS1 | #4 | datasource / datasource-empty | E | 原生 online_document 插件 | 需具体插件包/版本、目标账户与授权；验证 daemon/凭据读取、消息变量输出。现仅声明式 HTTP 桥。 |
| DS2 | #4 | datasource / datasource-empty | E | 原生 online_drive 文件生命周期 | 需具体 drive 插件/版本、账户、Dify 文件存储配置；验证真实下载、File、存储与下游提取。 |
| AG1 | #5 | agent | E | 原生 agent 策略插件 | 需指定策略包/版本/模型工具凭据；验证策略原生运行。当前仅显式 dsh-bounded-tools 替代与旧单轮。 |
| AG2 | #5 | agent | L | 策略/工具文件输出转换 | 真实工具产生文件并在最终 files 返回规范描述，不能一直固定 files=[]。 |
| AG3 | #5 | agent | L | agent 会话 memory | 将已声明 memory/window 接入真实会话，并验证跨 run 对模型请求的影响；当前未使用。 |
| AG4 | #5 | agent | L | 完整官方 usage 元数据 | 处理供应商已返回的 usage/计费字段；未提供价格时明确不可计算，不能虚构零费用。当前仅汇总 token 子集。 |
| WH1 | #6 | trigger / trigger-webhook | L | multipart/binary/file webhook 输入 | 真实 multipart/二进制传输及文件描述/下游提取；目前显式拒绝这些 content_type。 |
| WH2 | #6 | trigger / trigger-webhook | L | 原生 webhook 异步/响应配置 | 固定新版控制器为依据实现 async/response_body/timeout 模式；当前同步返回运行记录，只实现状态码配置。 |
| SC1 | #7 | trigger-schedule | E | Dify 原生调度计划互通 | 需指定 Dify 部署/固定版本与访问配置，验证 ScheduleService 创建/更新/删除及计划持久化。当前实现本地声明式 cron/visual 调度，未接原生计划服务。 |
| HU1 | #8 | human-input | L | 容器内部 checkpoint | iteration/loop 内 waiting 后准确恢复当前项与后续项，上游副作用不重放；目前编译前拒绝。 |
| HU2 | #8 | human-input | L | 高级 select/file 表单 | 按固定新版 schema 校验/恢复值并输出正确形状；目前仅 text/paragraph，高级字段编译前拒绝。 |
| HU3 | #8 | human-input | L | 自动 deadline 恢复 | 持久 pending 到期后自动走超时分支且只执行一次；目前须调用方显式 resume/轮询。 |
| HU4 | #8 | human-input | E | 原生表单权限/通知/回调生命周期 | 需指定 Dify 表单服务/权限配置和接收方；验证真实受权提交与通知。当前本地工具按 session 身份恢复。 |
| TP1 | #9 | trigger-plugin | E | 原生插件订阅生命周期 | 需具体事件插件包/版本/账户及 daemon 配置；验证订阅、事件、取消订阅。签名 HTTP 桥不执行原生订阅。 |
| CV1 | 审计外 | conversation | L | 失败/中止运行的变量提交边界 | 对标固定官方赋值/持久化路径，验证 assigner 之后失败或取消的跨 run 状态；当前仅成功/等待快照落盘。 |
| HT1 | 审计外 | http-request | L | 独立阶段 timeout | 分别执行 connect/read/write 预算；当前官方键已生效，但折合单一最大截止时间，不能证明三阶段等价。 |

RAG 按用户要求暂停，单列且不拆分验收子项：#2 knowledge-retrieval、#3 knowledge-index，共 2 组、2 个节点名。现有实现是词法检索与 placeholder，未扩展其算法。

未验证范围：公网 webhook 入站、真实公网 Jina 可达性、真实模型自治质量、全部时区/DST 组合、断电恢复，不计入上述子项。本地去重采用先 claimed 后执行，中断不自动重放，不承诺分布式 exactly-once；边界见 [event-deployment.md](event-deployment.md) / [human-wait.md](human-wait.md)。

依据：cd47a47 的 document_extractor / datasource / agent 固定节点函数，以及 5dff246 的 trigger*/human callback / ScheduleService，路径与函数分别见 [能力报告](capability-report.md) 和各部署协议。原始审计证据见 [reachability-audit.md](reachability-audit.md)。
