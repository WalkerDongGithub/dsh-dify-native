# 本地 agent 替代策略

固定官方依据：cd47a47c3b4acc4d4457b73777722602c33bc950，`api/core/workflow/nodes/agent/agent_node.py` 的 `_run`、`_transform_message`（输出 text/usage/files/json）；循环由 `api/factories/agent_factory.py:get_plugin_agent_strategy` 取得的插件策略负责。本地不宣称执行原策略。

显式设置 `agent_strategy_name: dsh-bounded-tools`，agent_parameters 包含 instruction/query、maximum_iterations（1..20，默认5）和 tools。工具对象为 `{provider_name, tool_name, provider_type?, parameters_schema?, tool_configurations?}`。tool_name 在节点声明中精确匹配，还须通过部署 DIFY_TOOL_ALLOW 及已有工具契约/显式 passthrough 规则。不声明 schema 时仍要求 arguments 为对象；要严格参数类型须声明 JSON schema。

本地模型文本协议：`{"tool_calls":[{"id":"unique-id","name":"lookup","arguments":{"key":"x"}}]}` 请求工具；其他文本为最终回答。每批调用先全部校验再执行，结果以 tool_result JSON 回灌模型。重复 id、未声明工具、参数不符、工具错误、取消、超出轮数都明确失败，失败不重试工具；已经完成的外部副作用不会自动回滚。不同 id 即使参数相同也视作新的显式请求。

输出 text/usage/files/json，json 为对象数组（无 JSON 时 `[{data:[]}]`），usage 汇总各轮 token 数并同时保留 camelCase 统计别名；未产生文件时 files=[]。没有伪造价格/供应商计费信息。meta.native_strategy=false。未选择本地策略时保留既有单轮兼容路径并明确标记；原生策略插件、插件文件消息、所有供应商 usage 字段、agent memory 完整等价仍为 S 子项。

验证 `tests/engine-agent-loop.test.mjs`：真实引擎、真实本地 HTTP 工具，只有 LLM 为固定文本流；验证反馈、输出形状、工具拒绝、schema、重复调用保护、上限及取消。未证明真实模型自治质量。
