# 事件入口部署协议

1.9.1 固定基线 cd47a47 无 trigger* / human-input。新增节点的源码依据另固定为 `5dff24671d7eb0db087a01b699444d2f1939f17e`，不冒称 1.9.1 原生节点：

- `api/core/workflow/nodes/trigger_webhook/node.py`，`TriggerWebhookNode._run` / `_extract_configured_outputs`：按配置输出 header（连字符换下划线）、query、body，以及 `_webhook_raw`。
- `api/core/workflow/nodes/trigger_schedule/trigger_schedule_node.py`，`TriggerScheduleNode._run`：透传已注入变量；调度由节点外的服务负责。
- `api/core/workflow/nodes/trigger_plugin/trigger_event_node.py`，`TriggerEventNode._run`：透传事件并附插件标识。原生订阅生命周期没有由名称推导。

调用工具 `dify_native_events({configPath:"/abs/events.json"})` 显式启动监听，随 Cordis 上下文释放。配置必须可信：它决定工作流、端口及凭据环境变量。默认仅绑定 127.0.0.1；公网入站没有验收。

```json
{"host":"127.0.0.1","port":9000,"stateDir":"/new/private/event-state","routes":[
 {"id":"deploy","endpoint":"/deploy","workflow":"/abs/flow.yml","token_env":"EVENT_TOKEN"},
 {"id":"plugin-bridge","endpoint":"/plugin","workflow":"/abs/plugin-flow.yml","token_env":"EVENT_TOKEN","signature_env":"EVENT_SIGNING_KEY","bridge":true,"inputs":{"topic":"body.event.topic"}}
]}
```

请求 method 对照节点配置（默认 POST），`Authorization: Bearer <token>`；必须有稳定 `X-Event-ID`。JSON/text body 最大 1 MiB，超出明确 413，不截断；multipart/binary 文件生命周期明确拒绝。可用 inputs 的点路径显式映射 body/headers/query 到 run args；普通 trigger 是本地扩展，无官方同名语义。webhook 按新版声明 headers/params/body 映射输出，旧 variables 参数注入仍保留。

plugin bridge 必须 `bridge:true`，签名 `X-Event-Signature` 为 hex HMAC-SHA256(key, `event-id + '.' + 原始UTF-8 body`)。本协议是外部桥，不调用 difypkg、daemon 或原生 subscription。meta/event 明确 `native_plugin_subscription=false`。签名不提供业务事件的新鲜度保证，稳定 event-id 负责本地去重。

接收成功时返回工作流真实运行记录（默认 HTTP200，可配 status_code）；执行失败/拒绝为422。鉴权401、未知路径404、method405、载荷错误400、ID冲突/中断认领409。先落盘 claimed 再执行；同 ID/同载荷重送返回 duplicate 与旧结果，变更载荷拒绝；进程在执行中崩溃不自动重放，需人工核查 claimed 与外部副作用。这是本机持久去重，不承诺跨存储 exactly-once。

真实验证 `tests/engine-events.test.mjs` 使用 real-harness、实际监听与真实 workflowEngine.start，检查 outputs、鉴权、重送、签名。没有证明公网、原生插件订阅、multipart 文件及完整异步 UI 生命周期；这些保持 S 子项。
