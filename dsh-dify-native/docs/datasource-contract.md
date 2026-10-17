# Datasource 部署协议

官方依据：Dify cd47a47c3b4acc4d4457b73777722602c33bc950，
`api/core/workflow/nodes/datasource/datasource_node.py` 的 `_run`、`_transform_message`、`_transform_datasource_file_message`。

运行输入必须显式传 `sys.datasource_type` 和对象 `sys.datasource_info`：

- `local_file`：info.file 是本地适配描述 `{path, filename?, mime_type?, related_id?}`。path 必须是真实工作区文件。输出 `{file, datasource_type}`；file 含 filename/extension/mime_type/size/transfer_method/path 等。Dify UploadFile 数据库 ID 不会被猜成本地路径。
- `website_crawl`：输出 `{...info, datasource_type}`；接收已有爬取结果，不谎称进行了爬取。
- `online_document` / `online_drive`：须部署声明式 HTTP 适配契约；未声明直接失败，不用任何插件参数猜文件。

`DIFY_DATASOURCES_ROOT` 为独立契约目录（冒号分隔）。格式复用 [工具契约](dify-tool-contract.md)，`provider` 对应 provider_name，`tool` 对应 datasource_name。参数来自 datasource_parameters，配置来自 datasource_configurations；额外可声明参数 datasource_info 接收系统信息。response.variables 显式映射远端变量；没有映射的工具 text/result/json 别名不出现在 datasource 输出。online_drive 必须显式映射 file，输出另补 datasource_type。

```yaml
provider: cloud
tool: page
parameters:
  - {name: page_id, required: true}
  - {name: token, form: form, required: true}
request:
  url: https://adapter.example/page
  query: {id: '{{parameters.page_id}}'}
  headers: {Authorization: 'Bearer {{credentials.token}}'}
response:
  variables:
    title: '{{response.title}}'
    content: '{{response.content}}'
```

该协议是替代桥，meta.engine=declarative-datasource-bridge、native_plugin=false；不执行 difypkg、OAuth 刷新、Dify credentials DB 或远端文件存储生命周期。真实认证云账户、native daemon 及文件存储互通仍为 S 子项。契约加载沿用工具契约的既有解析限制，需重启加载。

兼容扩展：仅 `provider_name=local/file`、缺省/builtin provider_type 且未传 datasource_type 时允许 records 模式，显式 parameters.path 读取 JSON/JSONL/UTF-8 文本，保持既有 records/record/count 字段；损坏 JSON 与二进制失败，不截断。datasource-empty 是本地别名，同一分派，无官方独立语义。

验证：`node tests/engine-datasource.test.mjs`，全部经过真实 workflowEngine.start，远端是本地 HTTP fixture；不能据此声称真实云账户可用。
