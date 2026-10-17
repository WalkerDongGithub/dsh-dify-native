# 流程控制语义依据

固定官方版本：[Dify 1.9.1](https://github.com/langgenius/dify/tree/cd47a47c3b4acc4d4457b73777722602c33bc950)，commit `cd47a47c3b4acc4d4457b73777722602c33bc950`。
调研时 main HEAD 为 `7c7f93bd530cc0a9fb7465ef59c28803edd1e286`，工单指定的三个节点路径在该版本不存在，因此采用上述可复查标签，不声称已经核对 main 的替代实现。

- `api/core/workflow/nodes/variable_aggregator/variable_aggregator_node.py`，`VariableAggregatorNode._run`：按选择器顺序选第一个存在的 Segment；不检查值是否为空，不按 output_type 改变行为。全部缺失返回 `{}`；group_enabled 时每组独立选择，缺失组省略，其余返回 `{group_name: {output: value}}`。
- `api/core/workflow/entities/variable_pool.py`，`VariablePool.get` / `add`；`api/factories/variable_factory.py`，`build_segment`；`api/core/variables/segments.py`，`NoneSegment` / `Segment.to_object`：缺失的池项返回 None；存在的 null 包装为 NoneSegment。空字符串、空数组、空对象、0、false、null 都是存在的值。JS undefined 用来表示缺失，因此不能复用 `__empty`。
- `api/core/workflow/nodes/iteration/entities.py`，`ErrorHandleMode`；`iteration_node.py`，`IterationNode._run_single_iter`：terminated 抛 IterationNodeError，`_run` / `_handle_iteration_failure` 将容器标为 FAILED；continue-on-error 在失败位置追加 None；remove-abnormal-output 不追加失败项。`_execute_parallel_iterations` 维护原始顺序，remove 模式最终过滤所有 None（也包括成功返回的 None），串行模式保留成功项的 None。本地基础三态已经实现，不存在“continueOnError 未使用”；仅并行 remove 成功 null 边界需要修复。
- `api/core/workflow/nodes/end/end_node.py`，`EndNode._run`：每个声明的 key 都赋值，缺失变量对应 None（JSON null）。本地已有行为正确，保留实现并加断言。

测试：`tests/control-semantics.test.mjs`；`--sample` 对真实 mature-ticket-triage.yml 的两个分支分别运行，使用实际 provider/Python 子进程和固定 LLM 回复（无网络、无模型调用）。修改前两个分支已经输出正确建议；没有观察到工单推测的样本错误。修改后结果应完全相同。

## 样本前后对比

输入工单：`退款尚未到账，请跟进。`，参数提取模型固定返回 priority=high / normal 和 keywords=[退款, 到账]，高优先级模型固定回复 `立即核查退款并联系客户。`。

| 运行分支 | 修改前 advice（3f45384） | 修改后 advice |
| --- | --- | --- |
| high | 立即核查退款并联系客户。 | 立即核查退款并联系客户。 |
| normal | 常规工单，按队列处理。 | 常规工单，按队列处理。 |

两个分支的 reply 均包含对应建议及两行关键词 `· 退款`、`· 到账`，keywords 均为 `["退款", "到账"]`；完整输出保存在 [triage-semantics-comparison.json](triage-semantics-comparison.json)，前后深度比较一致。原样本已正确处理未执行分支（undefined），不能声称本次修复改变了其输出。

重跑：`node tests/control-semantics.test.mjs --sample`。最终验证：`./tests/run-all.sh` → `ALL TESTS OK`。没有修改既有语义断言、诊断逻辑或依赖。

## HTTP 收尾修正（2026-10-18）

固定 cd47a47 的 `api/core/workflow/nodes/http_request/entities.py:HttpRequestNodeTimeout` 使用 connect/read/write（秒），不是 max_*_timeout；后者来自 get_default_config 的部署默认结构。engine-http-timeout.test.mjs 先复现官方键被忽略导致延迟响应成功，修复后实际请求超时走 fail-branch。旧 max_* 仅作显式兼容回退。目前仍将阶段预算合成单一最大截止时间；独立 connect/read/write 语义仍为 S，不宣称完整等价。

engine-http-follow.test.mjs 另先复现普通 HTTP 成功后下游被分支 guard 跳过、输出 null，修复到实际响应进入下游。仅 error_strategy=fail-branch 才按 HTTP handle 分支。既有测试断言未改。
