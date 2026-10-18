# 验证报告：dsh-dify-runtime 通路

日期：2026-10-17　机器：开发机（2C / 3.5G / 剩余 6.9G）
结论：**通路成立**——4 个未改动的真实 Dify 工作流已在本 harness 完整执行并产出正确结果；
不支持的节点会在执行前显式拒绝。最小转译闭环已落地为可安装的 dsh 插件。

---

## 一、抓取：先解决 .yml 来源

- 直连测试：`raw.githubusercontent.com` 实际返回 301/200（指引里说的 HTTP 000 当前未复现）；
  代理 `127.0.0.1:8890/8891` 同样可用，且 GitHub API 有 59 次余量。
- 来源仓库：`svcvit/Awesome-Dify-Workflow`（46 个 DSL）。
- 抓了 8 个候选，最终用 5 个（4 个跑通 + 1 个拒绝案例），**全部未改动**：

```
DSL/json-repair.yml                start → code → end
DSL/SEO Slug Generator.yml         start → llm → end
DSL/translation_workflow.yml       start → llm → if-else → llm → aggregator → llm → end
DSL/Form表单聊天Demo.yml           start → if-else → code → if-else → template/answer/assigner
DSL/LanguageConsistencyChecker.yml start → tool×3 → code×4 → llm×3 → end
```

原始 URL 前缀：`https://raw.githubusercontent.com/svcvit/Awesome-Dify-Workflow/main/DSL/`。

## 二、DSL 结构（踩到的关键坑）

1. 顶层不是 `graph`，而是 `workflow.graph`；第一次按 `doc["graph"]` 解析得到 0 个节点。
2. 节点的真实类型在 `node.data.type`；`node.type` 是 `"custom"`。
3. 边的分支出口在 `edge.sourceHandle`：if-else 是 `true`/`false`（或 case_id），
   普通节点是 `source`。
4. 变量引用是 `{{#<node-id>.<var>#}}`；template-transform 才是真 Jinja2，两种方言不能混。
5. `workflow.environment_variables` / `conversation_variables` 与 start 的
   `variables[]` 是三套不同的作用域。

## 三、转译与执行

实现路径（`<repo>/dsh-dify-runtime/`）：

```
YAML → dsl.py 解析 → IR（节点/边/sourceHandle/顺序/不支持清单）
     → preflight（图校验 + 不支持节点拒绝 + 必填输入）
     → engine.py 确定性 DAG 调度（入边 resolve + active 才执行）
     → nodes.py 适配器（code 子进程 / LLM / if-else / template / aggregator / assigner / http / classifier）
```

插件 `dsh-dify-runtime` 暴露 `dify_inspect` / `dify_translate` / `dify_run`，
已安装进独立 `difytest` profile，并在**真实 dsh 会话**中调用成功。

## 四、跑通结果

| 工作流 | 验证点 | 结果 |
| --- | --- | --- |
| json-repair | 纯代码节点、零 LLM、end 输出 | ✅ `{"a": 1, "b": [1, 2]}` |
| seo-slug | LLM 节点、system+user、模型映射 | ✅ `build-dify-workflow-small-server`（1 call / 123 tok） |
| translation | if-else **true 分支** + aggregator | ✅ 中文译文（3 calls / 918 tok） |
| translation | if-else **false 分支** + skip 记录 | ✅ 葡语译文（3 calls / 751 tok） |
| form-demo | template / answer / assigner / chat 模式 | ✅ 登录成功 + 表单提示两条路径 |
| lang-consistency | 不支持节点必须拒绝 | ✅ `rejected`，列出 3 个 `tool` 节点 id |
| 插件·json-repair | 真实 dsh 会话 → `dify_run` | ✅ succeeded，llmCalls=0 |
| 插件·seo-slug | 真实 dsh 会话 → `dify_run` | ✅ succeeded，llmCalls=1 |

最终 e2e 共 **7 次 LLM 调用 / 1792 tokens**；另有 6 项离线单测（mock LLM，0 token）。
证据：`runs/*.json`、`runs/*.trace.jsonl`、`runs/ir/*.ir.json`；复跑 `bash tests/e2e.sh`。

## 五、主要坑与修法

1. **PEP 668 禁止 pip install**：`json_repair` 用 `pip install --target runtime/vendor` 随包携带。
2. **zai 拒绝 system-only messages**（HTTP 400 / code 1214）：LLM 适配器补一条中性 user
   消息，并在节点 meta 里记录 `adapterNote`，不改原 prompt 内容。
3. **dsh 工具 schema 校验很窄**：`additionalProperties` 必须是 boolean，不能用 schema；
   `type: ["string","null"]` 不支持。已改成单类型。
4. **新 profile 没有 DEEPSEEK_API_KEY**：给测试 profile 配 `llm-pi-ai` 的 zai 路由，
   `agent-default-model` 指向 `glm-4.5-air`；web/headless 原 profile 未动。
5. **状态机 bug**：节点全成功但 run 报 failed；改为 `running → succeeded/failed`。
6. **skipped 节点最初不落结果**：现在每个 skipped 节点都有记录，不静默消失。
7. code 子进程不能用 `python -I`（会忽略 PYTHONPATH，vendor 失效），改用 `-s` + 显式
   `PYTHONPATH`。

## 六、明确未完成（不是"没时间"，是当前版本边界）

- **调度器没用 `ctx.workflowEngine`**：`workflow` 工具的 `agent()` 会把纯执行节点也变成
  subagent（强制 LLM 循环），与"零 LLM 执行单元 + 确定性"冲突；首版按定型方案 5.1/六
  实现独立确定性调度器。把 IR 编译到 workflowEngine 需要引擎先支持无 LLM 任务。
- **LLM 没走 `ctx.llm`**：目前是插件子进程里的 OpenAI 兼容适配器，直接读 `ZAI_API_KEY`。
- **code 没走 `ctx.sandbox`/landlock**：是独立子进程 + rlimit + 超时，仍能以当前用户
  访问网络。生产前必须补。
- **未实现节点**：tool/MCP、knowledge-retrieval、iteration/loop、agent、
  parameter/document-extractor、datasource、trigger、list-operator。这些一律预检拒绝。
- **未覆盖**：chat memory、vision/files、跨 run conversation 持久化、节点 retry/错误分支、
  与固定 Dify 版本的差分测试。http-request / question-classifier 适配器已写但无真实样本覆盖。

## 七、结论与下一步

「下载 DSL → 解析 → 确定性调度 → 本机执行」已经跑通，且插件形态可被 agent 直接调用。
它还不是完整产品：下一步优先把 LLM 切到 `ctx.llm`、code 切到 `ctx.sandbox`，
再用 10–20 个真实 DSL 做「只检查不执行」的 importer 覆盖，最后才对拍 Dify 语义。
