# 人工等待与恢复

1.9.1 固定基线 cd47a47 没有 human-input。依据另固定为 [Dify 5dff246](https://github.com/langgenius/dify/tree/5dff24671d7eb0db087a01b699444d2f1939f17e)：`api/core/workflow/nodes/human_input/callback.py` 的 `DifyHITLCallback.__call__`、`_build_special_outputs`、`render_form_content_with_outputs`，以及 `entities.py:HumanInputNodeData.must_resolve_action_value`。官方创建表单后 PauseRequested，提交后走选定 handle，超时走超时 handle；`__action_value` 为配置的 action.title，超时 id/value 为空字符串。

未显式注入 action 时，真实引擎执行到顶层 human-input 就返回等待快照，runner 返回 `status=waiting, pendingId, pending`，outputs={}，绝不自动选第一个动作。引擎实例随即释放，没有空转等待。

提交工具：`dify_native_resume({pendingId, action:"approve", inputs:{comment:"reviewed"}})`。必须在同一会话身份及 state root 下提交。text/paragraph 字段只接收已声明的字符串字段；默认值、动态 form_content 和 `$output` 渲染已实现。未到 deadline 必须显式选择已声明 action；到期后调用 resume（可不传 action）走 __timeout。没有后台通知/UI/自动 timeout callback，目前需调用方提交或轮询；这是剩余 S 子项。

状态默认在会话工作区 `.dify-native-state`，可设 DIFY_STATE_DIR。pending 保存已完成节点/分支/变量/answers、原输入及编译脚本 hash。服务重开后能恢复；先恢复绑定，再跳过全部已完成节点。已有等待时，普通新 run 会拒绝，提示使用 resume，避免重新执行上游副作用或覆盖会话变量。工作流改变则拒绝恢复。提交先持久 claimed，再执行；同提交重送返回旧结果，修改提交拒绝；中断 claimed 不自动重放，必须人工核查。状态锁不自动清除。文件系统持久化可配置，但未宣称分布式事务或跨机 exactly-once。

原有 `human.<nodeId>.action` / `action` 显式注入路径保留，meta.autoResolved=true、source=explicit-action-injection。真实 pending 提交为 autoResolved=false、source=pending-submission。超时单位按固定源码 hour/day，timeout=0 允许即时到期。

边界：顶层顺序等待、多个连续顶层等待、已完成容器后的等待可表示；容器内部暂停当前在编译时明确拒绝，避免从容器头重放。高级 select/file 表单模式也在执行前明确拒绝，仍为 S；不擅自当字符串。未验 Dify 通知/权限链接/数据库表单生命周期。不能声称 human-input 全兼容。

验证 `tests/engine-human-wait.test.mjs`：实际 HTTP 副作用 → waiting → 关闭重开 → 提交 → 正确分支；副作用总计一次。重复提交、无效动作、等待时误新 run、到期恢复均断言。`engine-human-form.test.mjs` 先复现未插值与变量默认值问题，再验证逐字 form 输出。所有路径复用 real-harness 并实际 workflowEngine.start，未 mock 引擎。
