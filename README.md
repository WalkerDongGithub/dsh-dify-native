# dsh-dify-native

在 **dsh harness 自己的能力上**跑真实的 Dify 工作流 `.yml`：用 dsh 的 workflow engine、
subagent seam、沙箱和模型路由，不另写调度器、不部署 Dify。

## 这是什么：一个需求，加一个自己的方案

**目的：想用更小的代价跑 workflow。**

现在的选择其实都不舒服：部署一套完整 Dify 能拿到画布、生态和确定性编排，但代价是 PG + Redis +
API + worker + sandbox + plugin daemon 一整套基础设施；用 agent 自然语言驱动很轻，但没有确定性
（同样的输入两次结果可能不同，不可复现、不可审计）；自己写编排脚本确定且轻量，但没有任何生态，
每个流程从零写。

这个项目想走第四条路：**借 Dify 的生态和确定性编排，用 dsh 的模型、沙箱和工具把它执行掉。**
Dify 贡献的是 `.yml` 这个格式和画布上画出来的确定性流程；模型、沙箱、工具、凭据、会话、订阅
全部用 dsh 现成的。**dsh 源码零改动。**

- **这不是一个可替代 Dify 的产品**，也不是"一定能跑你的工作流"的承诺。
- 它是一个观点加一个方案的第 N 版实现：证明了这条路是通的，并把边界摊开给人看。
- 后续会继续更新；判断某张图能不能跑，以 `dify_native_inspect` 的结果为准，不以本文档为准。

## 借什么、不借什么

| 借 | 不借 |
| --- | --- |
| Dify 的 `.yml` 格式（别人画的、社区里现成的图可以直接用） | 插件 daemon、`.difypkg` 生态 |
| Dify 的画布语义（分支、循环、并行、变量作用域是确定的） | 向量库 / 知识库（RAG 本轮暂停） |
| 社区工作流的常见写法 | Dify 原生调度服务、原生事件订阅 |

模型、沙箱、工具、凭据、会话记忆、事件与调度，**全部用 dsh 的**。有一处和 Dify 行为不同但
要提前讲清楚：**`llm` 节点的模型可能被 dsh profile 接管**（DSL 里写 deepseek，实际可能跑在
profile 默认模型上）。这是有意的——这正是"用 dsh 的模型预算跑 Dify 的图"的意义所在。
每个节点记录里都有 `meta.provider / meta.model / meta.routeSource`，事后可查。

- 默认分支：`main`。**本仓库（Gitea）是主仓，GitHub 上是只读镜像。**
- 插件本体：`dsh-dify-native/`，**使用说明见 [dsh-dify-native/README.md](dsh-dify-native/README.md)**
- dsh 源码未做任何修改

## 快速开始

```bash
# 从公开镜像克隆（或从 Gitea 主仓克隆，二者内容一致）
git clone https://github.com/<owner>/dsh-dify-native.git
cd dsh-dify-native/dsh-dify-native
npm ci
./tests/run-all.sh          # → ALL TESTS OK（需要已装 dsh、python3、ripgrep）
```

挂进 profile、可选 Python 依赖、能力边界与已知降级：[**dsh-dify-native/README.md**](dsh-dify-native/README.md)。

**使用前先读安全边界**：只跑你自己可信来源的 `.yml`。`template-transform` 的 Jinja 模板在
nunjucks 里渲染、**不是沙箱**；`code` 节点的 landlock 在部分环境只报 `partial` enforcement；
`tool` 声明式契约会把凭据拼进请求。详见插件 README。

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

## 这份东西没有保证什么

写清楚，避免误用：

- **没有和 Dify 官方执行器做逐字段对拍**（只有文档提取做了 8 种格式的逐字差分）。
- 没有在真实公网规模下验证：webhook 入站、公网 Jina 可达性、全部时区/DST、断电恢复。
- 没有验证"真实模型自治质量"——测试里 LLM 用固定回复，不证明模型跑得好。
- Dify 新增的节点类型会标成 `node-unknown`：**图会继续走，但不做这个节点的活**。这是最需要
  `inspect` 的地方。
- 测试证明的是"实现符合意图、真引擎确实跑出这些 outputs"，**不**证明"和 Dify 逐字段一致"。

## 历史说明

这个仓库最早同时装了两个方案：一个自带 Python runtime 与 DAG 调度器的实现，和一个复用 dsh
原生能力的实现。结论是后者胜出——**前者已从主干移除**（需要时在 git 历史里可查）。
仓库因此改名为 `dsh-dify-native`，与仍在使用的实现一致。

## 维护（仅供主仓维护者）

**主仓在 Gitea，GitHub 上是只读镜像。** 公开镜像的日常操作：

```bash
git push origin main           # 先推 Gitea 主仓
git push github main           # 再同步 GitHub 镜像
```

Gitea 实例的地址、账号与 token 不写进本仓库；需要时由维护者在本机配置。
