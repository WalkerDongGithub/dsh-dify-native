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

请求 method 对照节点配置（默认 POST），`Authorization: Bearer <token>`；必须有稳定 `X-Event-ID`。JSON/text body 最大 1 MiB，超出明确 413，不截断；multipart/binary 文件生命周期明确拒绝。可用 inputs 的点路径显式映射 body/headers/query 到 run args；普通 trigger 是本地扩展，无官方同名语义。webhook 按新版声明 headers/params/body 映射输出，旧 variables 参数注入仍保留。webhook/schedule/plugin 输出同时透传 sys.* 系统变量，按固定新版 `_run` 行为；相关真实引擎回归已断言 sys.conversation_id。inspect 将事件桥标为 simplified，保留原生差距。

plugin bridge 必须 `bridge:true`，签名 `X-Event-Signature` 为 hex HMAC-SHA256(key, `event-id + '.' + 原始UTF-8 body`)。本协议是外部桥，不调用 difypkg、daemon 或原生 subscription。meta/event 明确 `native_plugin_subscription=false`。签名不提供业务事件的新鲜度保证，稳定 event-id 负责本地去重。

接收成功时返回工作流真实运行记录（默认 HTTP200，可配 status_code）；执行失败/拒绝为422。鉴权401、未知路径404、method405、载荷错误400、ID冲突/中断认领409。先落盘 claimed 再执行；同 ID/同载荷重送返回 duplicate 与旧结果，变更载荷拒绝；进程在执行中崩溃不自动重放，需人工核查 claimed 与外部副作用。这是本机持久去重，不承诺跨存储 exactly-once。

真实验证 `tests/engine-events.test.mjs` 使用 real-harness、实际监听与真实 workflowEngine.start，检查 outputs、鉴权、重送、签名。没有证明公网、原生插件订阅、multipart 文件及完整异步 UI 生命周期；这些保持 S 子项。

定时调度：先 `./scripts/install-events.sh` 将固定 croniter==6.2.4 安装到新 `.vendor-events`（或 DIFY_EVENTS_VENDOR），不覆盖已有目录。配置增加 schedules：

```json
{"schedules":[{"id":"daily","workflow":"/abs/schedule.yml","cron":"0 9 * * *","timezone":"Asia/Shanghai","start_at":"2026-10-18T00:59:00.000Z"}]}
```

声明式 cron 或节点 cron_expression 支持5字段或 croniter @daily 等别名；使用 IANA 时区，默认 UTC。启动后每30秒检查（poll_ms 可配，最低100ms）；输出 triggered_at 为实际调度槽 UTC 时间，替代旧 epoch。start_at 缺省从启动时起算；重启读取已持久化位置并补偿，单次超过1000槽明确失败，不能静默截断。每槽同样先 claimed，再调用真实 runner；已失败工作流不自动重试副作用。可用 runtime.tick(Date) 做受控时钟验证，实际交付仍走 workflowEngine.start。时钟倒退不回放。visual 模式复用固定新版 `api/services/trigger/schedule_service.py:ScheduleService.visual_to_cron` 与 `api/libs/schedule_utils.py:convert_12h_to_24h`，实现 hourly/daily/weekly/monthly（含 last），无需手工改写 cron。croniter 缺失明确给安装命令；定时错误写 stderr，保留持久 claimed，不静默成功。

`tests/engine-schedule.test.mjs` 真实验证 Asia/Shanghai 09:00 → UTC01:00、同槽去重、关闭重开后的补偿，不以 mock 引擎替代交付。计时器生命周期关闭已验证，公网及分布式调度未验。

新增 `tests/engine-schedule-visual.test.mjs` 先真实失败（缺少 cron 转换），修复后四种 visual 频率均实际启动引擎并断言 UTC 槽时间。转换函数保存在 lib/schedule-parser.py，来源固定 5dff246。
