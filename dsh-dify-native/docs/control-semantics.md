# 流程控制语义依据

固定官方版本：[Dify 1.9.1](https://github.com/langgenius/dify/tree/cd47a47c3b4acc4d4457b73777722602c33bc950)，commit `cd47a47c3b4acc4d4457b73777722602c33bc950`。
调研时 main HEAD 为 `7c7f93bd530cc0a9fb7465ef59c28803edd1e286`，工单指定的三个节点路径在该版本不存在，因此采用上述可复查标签，不声称已经核对 main 的替代实现。

- `api/core/workflow/nodes/variable_aggregator/variable_aggregator_node.py`，`VariableAggregatorNode._run`：按选择器顺序选第一个存在的 Segment；不检查值是否为空，不按 output_type 改变行为。全部缺失返回 `{}`；group_enabled 时每组独立选择，缺失组省略，其余返回 `{group_name: {output: value}}`。
- `api/core/workflow/entities/variable_pool.py`，`VariablePool.get` / `add`；`api/factories/variable_factory.py`，`build_segment`；`api/core/variables/segments.py`，`NoneSegment` / `Segment.to_object`：缺失的池项返回 None；存在的 null 包装为 NoneSegment。空字符串、空数组、空对象、0、false、null 都是存在的值。JS undefined 用来表示缺失，因此不能复用 `__empty`。
- `api/core/workflow/nodes/iteration/entities.py`，`ErrorHandleMode`；`iteration_node.py`，`IterationNode._run_single_iter`：terminated 抛 IterationNodeError，`_run` / `_handle_iteration_failure` 将容器标为 FAILED；continue-on-error 在失败位置追加 None；remove-abnormal-output 不追加失败项。`_execute_parallel_iterations` 维护原始顺序，remove 模式最终过滤所有 None（也包括成功返回的 None），串行模式保留成功项的 None。本地基础三态已经实现，不存在“continueOnError 未使用”；仅并行 remove 成功 null 边界需要修复。
- `api/core/workflow/nodes/end/end_node.py`，`EndNode._run`：每个声明的 key 都赋值，缺失变量对应 None（JSON null）。本地已有行为正确，保留实现并加断言。

测试：`tests/control-semantics.test.mjs`；`--sample` 对真实 mature-ticket-triage.yml 的两个分支分别运行，使用实际 provider/Python 子进程和固定 LLM 回复（无网络、无模型调用）。修改前两个分支已经输出正确建议；没有观察到工单推测的样本错误。修改后结果应完全相同。
