# dsh-dify-native

在 **dsh harness 自己的能力上**跑真实的 Dify 工作流 `.yml`：用 dsh 的 workflow engine、
subagent seam、沙箱和模型路由，不另写调度器、不部署 Dify。

- Gitea：<http://127.0.0.1:8443/walker/dsh-dify-native>
- 默认分支：`main`
- 插件本体：`dsh-dify-native/`，**使用说明见 [dsh-dify-native/README.md](dsh-dify-native/README.md)**
- dsh 源码（`/home/walker/deepseek-harness/`）未做任何修改

## 快速开始

```bash
git clone http://127.0.0.1:8443/walker/dsh-dify-native.git
cd dsh-dify-native/dsh-dify-native
npm ci
./tests/run-all.sh          # → ALL TESTS OK
```

挂进 profile、可选 Python 依赖、能力边界与已知降级：[**dsh-dify-native/README.md**](dsh-dify-native/README.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `dsh-dify-native/` | 插件本体：Dify DSL → IR → 编排脚本，复用 dsh 原生能力 |
| `dsl/` | 真实 Dify 工作流样本（json-repair / translation / seo-slug / jieba / form-demo 等） |
| `dsl/research/` | 科研向工作流样本（ChatPaper / NotebookLM / DeepResearch / GPT-Researcher / matplotlib） |
| `tools/` | 声明式工具契约样例（复制到 `~/.dsh-dify/tools` 即可用） |
| `runs/` | 历史验证产物：逐节点 trace、IR、运行结果 |
| `spikes/`、`harness-spikes/` | 早期调研脚本（沙箱、workflow engine、离线 DSL） |
| `验证报告_*.md` | 早期的通路验证与方案对比报告，**结论已并入插件 README** |

`runs/` 里的 `sandbox-*`、`.dify-probe-*` 是一次性临时目录，已在 `.gitignore` 中排除。

## 历史说明

这个仓库最早同时装了两个方案：一个自带 Python runtime 与 DAG 调度器的实现，和一个复用 dsh
原生能力的实现。结论是后者胜出——**前者已从主干移除**（需要时在 git 历史里可查）。
仓库因此改名为 `dsh-dify-native`，与仍在使用的实现一致。

## 维护

Gitea 监听 `127.0.0.1:8443`（SSH 已 `DISABLE_SSH = true`，`REQUIRE_SIGNIN_VIEW = true`，
网页和 clone 都需要登录/凭据）。walker 的 HTTP token 存在 `~/.git-credentials`：

```bash
git clone http://127.0.0.1:8443/walker/dsh-dify-native.git
git push origin main
```

现有 token 只有 `write:repository` 权限，够 push；要建新仓库（`POST /user/repos`
需要 `write:user`）时，用服务器上的 gitea CLI 临时生成全权限 token：

```bash
/home/walker/.local/bin/gitea -w /home/walker/gitea -c /home/walker/gitea/app.ini \
  admin user generate-access-token -u walker -t <名字> --scopes all --raw
```
