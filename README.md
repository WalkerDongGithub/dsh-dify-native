# dsh-dify-runtime

把 Dify 工作流 `.yml`（DSL）转译到 dsh harness 上运行。本仓库是 2026-10-17 在
walker server 上完成的一轮验证的完整归档：插件代码、Dify DSL 样本、验证产物与报告。

- Gitea：<http://116.204.96.133:8443/walker/dsh-dify-runtime>
- 默认分支：`main`
- dsh 源码（`/home/walker/deepseek-harness/`）未做任何修改。

## 目录

| 路径 | 内容 |
| --- | --- |
| `dsh-dify-runtime/` | 主插件：Dify DSL 解析 → IR → 确定性 DAG 调度；Python runtime + JS 插件壳 |
| `dsh-dify-native/` | 原生桥接方案：复用 dsh 的 workflowEngine / subagents / llm / sandbox，不自写调度器 |
| `dsl/` | 真实 Dify 工作流样本（json-repair / translation / seo-slug / jieba / form-demo 等） |
| `runs/` | 验证产物：逐节点 trace、IR、运行结果、原生对照结果 |
| `spikes/`、`harness-spikes/` | 沙箱、workflow engine、离线 DSL 等调研脚本 |
| `验证报告_*.md` | 两轮验证报告（通路验证、拿来主义重构） |

`runs/` 里的 `sandbox-*`、`.dify-probe-*` 是一次性临时目录，已在 `.gitignore` 中排除。

## 快速开始

```bash
# CLI：看结构 / 转译 / 执行
cd dsh-dify-runtime
PYTHONPATH=runtime python3 -m dify_runtime inspect ../dsl/json-repair.yml
PYTHONPATH=runtime python3 -m dify_runtime translate ../dsl/json-repair.yml -o ../runs/ir/json-repair.ir.json
PYTHONPATH=runtime python3 -m dify_runtime run ../dsl/json-repair.yml \
  --input '{"llm_string":"{\"a\": 1, \"b\": [1,2,], }"}' \
  --trace ../runs/json-repair.trace.jsonl
```

LLM 节点默认读 `ZAI_API_KEY`（环境变量或 `~/.dsh/.credentials.yaml` 的 refs），
默认端点 `https://api.z.ai/api/paas/v4`，默认模型 `glm-4.5-air`。

回归测试：

```bash
cd dsh-dify-runtime && python3 tests/test_runtime.py
```

## 维护

本机认证走 HTTP token（SSH 在 Gitea 侧 `DISABLE_SSH = true`），凭据存在
`~/.git-credentials`，clone/push 直接用：

```bash
git clone http://127.0.0.1:8443/walker/dsh-dify-runtime.git
git push origin main
```
