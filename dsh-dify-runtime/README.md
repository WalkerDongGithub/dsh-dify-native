# dsh-dify-runtime（最小验证版）

把 Dify 工作流 `.yml`（DSL）解析成 IR，用**确定性 DAG 调度器**在 walker server 的
dsh harness 上执行。目标不是复刻 Dify，而是验证「下载 DSL → 转译 → 本机跑通」这条通路。

**结论：通路成立。** 4 个未改动的真实 Dify 工作流（代码节点、LLM 节点、if-else
双分支、variable-aggregator、template-transform、answer、assigner）已完整跑通；
含未实现节点（`tool`）的工作流会在执行前被明确拒绝。

- 实测 4 个真实工作流 + 1 个显式拒绝案例（见 `../runs/`）
- 离线回归测试 6 项全绿
- 真实 dsh profile 内通过 `dify_run` 工具调用成功（Code 与 LLM 两条路径）
- 验证总消耗约 1.8k tokens（最终 e2e 7 次 LLM 调用）

---

## 1. 快速开始

### CLI（不依赖 dsh 会话，便于调试）

```bash
cd /home/walker/dify-test/dsh-dify-runtime

# 1) 看结构，不执行
PYTHONPATH=runtime python3 -m dify_runtime inspect ../dsl/json-repair.yml

# 2) 转译成 IR
PYTHONPATH=runtime python3 -m dify_runtime translate ../dsl/json-repair.yml -o ../runs/ir/json-repair.ir.json

# 3) 执行
PYTHONPATH=runtime python3 -m dify_runtime run ../dsl/json-repair.yml \
  --input '{"llm_string":"{\"a\": 1, \"b\": [1,2,], }"}' \
  --trace ../runs/json-repair.trace.jsonl
```

LLM 节点需要一个 OpenAI 兼容端点。默认读取 `ZAI_API_KEY`（环境变量或
`~/.dsh/.credentials.yaml` 的 refs），默认端点 `https://api.z.ai/api/paas/v4`，
默认模型 `glm-4.5-air`：

```bash
export ZAI_API_KEY=...
# 可选：DIFY_LLM_BASE_URL / DIFY_LLM_MODEL / DIFY_MODEL_MAP / DIFY_LLM_MAX_TOKENS_CAP
```

### 作为 dsh 插件

```bash
dsh plugin --profile <profile> add /home/walker/dify-test/dsh-dify-runtime
dsh --profile <profile> --dump-config | grep dify   # 应看到 dsh-dify-runtime
```

提供 3 个工具：

| 工具 | 作用 |
| --- | --- |
| `dify_inspect` | 解析 DSL，报告节点类型、start 输入、执行顺序、不支持节点、图问题；不执行 |
| `dify_translate` | 输出规范化 IR（可写文件） |
| `dify_run` | 确定性执行，返回逐节点状态 / 分支 / 最终输出 / LLM 用量 |

工具只做参数校验和子进程调度；解析、调度、节点适配在 Python runtime 中，
`code` 节点在**独立子进程**执行，不进入 host 插件进程。

---

## 2. 架构

```
Dify YAML
  → dsl.load_workflow()       安全 YAML 解析，取 workflow.graph，节点类型取 data.type
  → Workflow.to_ir()          规范化 IR：节点/边/sourceHandle/执行顺序/不支持清单
  → engine.preflight()        图校验 + 不支持节点拒绝 + 必填输入检查（执行前）
  → Engine.run()              确定性 DAG 调度：入边全部 resolve 且至少一条 active 才执行
  → nodes.EXECUTORS[type]     节点适配器
      ├─ start / end / answer
      ├─ code                 → 独立 python3 子进程（rlimit + timeout）
      ├─ llm                  → OpenAI 兼容适配器（模型映射，记录原模型与实模型）
      ├─ if-else              → 按 DSL 条件求值，代码选择分支，LLM 不参与
      ├─ template-transform   → 真 Jinja2（不是字符串替换）
      ├─ variable-aggregator / assigner / http-request / question-classifier
      └─ 其他                 → UnsupportedNode（预检阶段拒绝）
```

关键语义：

- **确定性**：执行顺序由拓扑排序 + 边的 `sourceHandle` 决定。LLM 只产出文本/类别，
  不能决定下一节点；分类结果由代码映射回预定义边。
- **分支**：`if-else` 返回 case_id，只有 `sourceHandle == case_id` 的边被激活；
  另一分支的节点标记 `skipped` 并写入结果，不会静默消失。
- **失败**：节点异常默认中止并记录；`error_strategy: continue-on-error/default-value`
  时按 `default_value` 恢复。首版不做跨进程续跑。
- **preflight**：有未知/未实现节点时整个 run 返回 `rejected`，`nodes` 为空，
  错误信息列出具体 id/type——不静默跳过。

---

## 3. 节点支持矩阵

| 节点 | 状态 | 说明 |
| --- | --- | --- |
| start / end / answer | ✅ | 类型转换、`sys.query`、终态输出、多 answer |
| code (python3) | ✅ | 子进程 + CPU/内存/文件 rlimit + 超时；`json_repair` 已 vendored |
| llm | ✅ | chat 模式、system/user/assistant、temperature/max_tokens、结构化输出开关 |
| if-else | ✅ | `and/or`、`= ≠ > < ≥ ≤ contains start with end with empty null` 等 |
| template-transform | ✅ | 真 Jinja2，`StrictUndefined` |
| variable-aggregator | ✅ | 取第一个非 None 的选择器 |
| assigner | ✅ | over-write / append / clear，写 conversation/node 作用域 |
| http-request | ✅（已实现，未由样本覆盖） | 仅 http(s)，拒绝私网/回环地址；JSON/raw/form body |
| question-classifier | ✅（已实现，未由样本覆盖） | LLM 分类 + 代码选边，防未知类别 |
| tool / MCP | ❌ 显式拒绝 | 需要工具提供方与凭据绑定，未实现 |
| knowledge-retrieval | ❌ 显式拒绝 | 需要向量库/embedding 资源迁移 |
| iteration / loop | ❌ 显式拒绝 | 嵌套作用域与取消未验证 |
| agent | ❌ 显式拒绝 | 工具策略与图边界未实现 |
| parameter-extractor / document-extractor / datasource / trigger / list-operator | ❌ 显式拒绝 | 未实现 |

---

## 4. 验证结果

样本来自 `svcvit/Awesome-Dify-Workflow`（GitHub，代理抓取，未改动）：

| 工作流 | 节点 | 验证点 | 结果 |
| --- | --- | --- | --- |
| `json-repair.yml` | start→code→end | 零 LLM、代码节点、变量绑定、end 输出 | ✅ `{"a": 1, "b": [1, 2]}` |
| `seo-slug.yml` | start→llm→end | LLM 节点、system+user prompt、模型映射 | ✅ `build-dify-workflow-small-server`（1 call） |
| `translation.yml` | start→llm→if-else→llm→aggregator→llm→end | if-else **true/false 双分支**、aggregator、skip 记录 | ✅ 中文/葡语输出；3 calls/分支 |
| `form-demo.yml` | start→if-else→code→if-else→template/answer/assigner | template-transform、answer、assigner、chat 模式 | ✅ 两条路径；登录成功/表单提示 |
| `lang-consistency.yml` | 含 3 个 `tool` 节点 | **不支持必须显式拒绝** | ✅ `rejected`，nodes 为空，列出 3 个 tool id |

证据文件：

- `../runs/*.json`：每次 run 的完整结果（节点状态、分支、输出、usage）
- `../runs/*.trace.jsonl`：逐事件 trace（含 skipped）
- `../runs/ir/*.ir.json`：转译后的 IR
- `tests/e2e.sh`：一条命令复跑以上 4 个 + 拒绝案例
- `tests/test_runtime.py`：6 项离线回归（mock LLM，不烧 token）
- `tests/plugin-harness.mjs`：插件工具面的离线集成测试

真实 harness 内部调用（`difytest` profile，zai 驱动）已验证：

```
dify_run(json-repair) -> succeeded, output {"a": 1, "b": [1, 2]}, llmCalls=0
dify_run(seo-slug)    -> succeeded, output build-dify-workflow-small-server, llmCalls=1
```

复现方式：`tests/difytest-profile.patch.yml` 是测试 profile 的 LLM 配置
（zai 路由 + 禁用无 key 的 deepseek 路由）。装插件后：

```bash
export ZAI_API_KEY=...
cat > /tmp/task.txt <<'PROMPT'
Call the dify_run tool exactly once with path=/home/walker/dify-test/dsl/json-repair.yml
and inputs={"llm_string":"{\"a\": 1, \"b\": [1,2,], }"}. Print the status and outputs.
PROMPT
dsh --profile difytest - < /tmp/task.txt
```

---

## 5. 已知限制 / 与定型方案的偏差（必须明说）

0. **调度器是插件自有的，不是 `ctx.workflowEngine`**：`workflow` 工具的 `agent()`
   会把每个节点变成 subagent，纯代码/模板节点也会被迫走 LLM 循环，违背"零 LLM
   执行单元"和确定性铁律。因此首版按定型方案 5.1/六实现了独立确定性调度器；
   后续可把 IR 编译成 workflowEngine 的任务图，但需要引擎先支持无 LLM 节点。
1. **LLM 未走 `ctx.llm`**：当前是插件子进程内的 OpenAI 兼容适配器，直接读
   `ZAI_API_KEY`。`ctx.llm` 的服务化接入是下一步；首版这样做的原因是把 runtime
   做成可独立 CLI 调试、不绑定宿主内部 API。
2. **code 节点不是 landlock**：是独立子进程 + rlimit + 超时，未接入
   `ctx.sandbox`。它能以 walker 用户身份访问网络；生产版必须换成宿主沙箱。
3. **模型语义不保留**：所有 Dify 模型（deepseek/openai/anthropic/qwen…）都映射到
   同一 zai 模型。`glm-4.5-air` 不支持某些 provider 特性（vision、特定 JSON mode）。
   映射在 trace 的 `modelRequested/modelUsed` 中可审计。
4. **只支持 DSL 0.1.x 实测**：0.1.0/0.1.2/0.1.3 样本通过；更新的 graphon schema
   （0.2+）未验证。未知字段会被忽略，不会报错。
5. **未实现的语义**：chat memory、vision/files、RAG、tool/MCP、iteration/loop、
   agent、`structured_output` 之外的 JSON schema 校验、节点级 retry 上限、
   错误分支（failure 边）、跨 run 的 conversation 变量持久化。
6. **Jinja 比 Dify 严格**：`StrictUndefined` 下缺变量会报错，Dify 默认渲染为空。
   这是有意的（宁可失败也不产出静默错误），但属于兼容性差异。
7. **http/question-classifier 适配器未由真实样本覆盖**：仅代码路径存在，未做
   差分测试。
8. **没有与固定版本 Dify 做差分测试**：调度正确性目前由真实工作流结果 + 单测
   证明，不是逐节点对拍。
9. **只支持单工作流、串行执行**：并发=1，符合 2 核/3.5G 的约束；未做并发调度。

---

## 6. 复现

```bash
cd /home/walker/dify-test/dsh-dify-runtime

# 离线单测（不联网、不调 LLM）
PYTHONPATH=runtime DIFY_PYLIB="$PWD/runtime/vendor" python3 -m unittest discover -s tests -v

# 插件工具面
node tests/plugin-harness.mjs

# 真实工作流 e2e（会调用 zai，约 1.8k tokens）
export ZAI_API_KEY=...
bash tests/e2e.sh
```

环境：walker server，Python 3.12，PyYAML 6.0.1，Jinja2 3.1.2；
`runtime/vendor/json_repair` 已随包携带，无需额外 pip install。

---

## 7. 下一步（按优先级）

1. 把 LLM 适配器切到 `ctx.llm`（插件内通过服务调用），去掉直接 HTTP + 明文 key。
2. 把 code 子进程接到 `ctx.sandbox`（landlock），封网络/文件系统。
3. 补 `tool` / `knowledge-retrieval` 的资源绑定与能力预检；先做「只检查不执行」
   的 importer 覆盖 20 个真实 DSL。
4. 对固定 Dify 版本做差分测试：同一 DSL/输入，比较激活路径、变量结果、异常。
5. 补 iteration/loop 的嵌套作用域与取消，再谈 agent 节点。
