# dsl/research —— 科研向 Dify 工作流样本

从社区 DSL 合集里挑出来的「科研人用得上」的那部分，**原样保存、一个字节没改**，
交给 `dsh-dify-native` 用。和 `dsl/` 根目录那批「节点覆盖样本」不一样：根目录是测试夹具，
这里是真实出处的工作流，用来回答「这张图在 native 上到底能不能跑、要准备什么」。

- 来源：[`dzh-gitcode/dify-workflows`](https://github.com/dzh-gitcode/dify-workflows)（272 个 DSL，2026-06 仍在更新）
- 抓取：2026-10-18，取自仓库 `main` 分支；未固定 commit，上游后续更新可能已有新版
- 原始路径见下表，逐字对应

## 清单（分档是 `dify_native_inspect` 的真实输出）

| 文件 | 原始路径 | 用途 | 节点 | full / simplified | 结构 issue | 能编译 |
| --- | --- | --- | --- | --- | --- | --- |
| `matplotlib.yml` | `05_数据分析表格/matplotlib.yml` | 自然语言 → Python 画图 | 3 | 2 / 0 | **0** | ✅ |
| `notebooklm.yml` | `03_知识库文档处理/NotebookLM.yml` | 多文档问答 + 合成（可出播客音频） | 16 | 7 / 3 | **0** | ✅ |
| `deepresearch.yml` | `10_搜索资讯/DeepResearch.yml` | 迭代检索 → 自评够不够 → 带引用报告 | 23 | 14 / 1 | **0** | ✅ |
| `gpt-researcher.yml` | `10_搜索资讯/GPT-Researcher .yml` | 同上，`workflow` 模式，分章节出报告 | 22 | 10 / 2 | **0** | ✅ |
| `deep-researcher-on-dify.yml` | `10_搜索资讯/Deep Researcher On Dify .yml` | 最大的一张：多轮迭代 + 知识库检索 | 71 | 42 / 10 | 8 | ❌ 导出本身是坏的 |
| `chatpaper.yml` | `03_知识库文档处理/ChatPaper.yml` | 论文精读：输入 PDF，抽关键图/方法/创新点 | 42 | 26 / 4 | 2 | ❌ 导出本身是坏的 |
| `lit-review-writing.legacy-completion.yml` | `03_知识库文档处理/文献综述写作.yml` | **不是 workflow**：老式 `completion` 应用，只有一段 pre_prompt | — | — | — | — |

四张「0 issue」的图是 `passthrough` 为 0 的干净样本，`compileGraph` 直接通过。
`matplotlib` 最干净（start / code / answer 三个节点），拿它当第一张试运行。

两张 ❌ 的坏在哪：

- **`deep-researcher-on-dify`**：一个 if-else 把同一个分支 handle（`fdc117e5…`）连到 5 个下游节点，
  加上 7 个没接下游的 assigner（`问题变量赋值`、`上下文变量赋值`）。Dify 画布上看起来能跑，
  是因为它允许分支多出 —— 但这里的多出是原作者拖拽留下的残骸，native 拒绝执行是对的。
- **`chatpaper`**：2 个悬空 assigner（`更新对话阶段` / `存储原始论文`，`assigned_variable_selector`
  还在，但没接任何边）。

要跑这两张，先删掉那几个孤立节点，或在 Dify 里重导一遍。

`lit-review-writing` 保留是因为 prompt 写得还行（要求 `(3)` 式文献标记 + 文末参考文献），
可以抄去当 prompt 素材；它没有 `workflow.graph`，`inspect` 会直接报 `DSL has no workflow block`，
别往 run 上试。

## 用之前要知道的

1. **代码节点没有第三方库。** 这些图的 code 节点只做列表/字符串处理，没问题；但如果你的图里
   调 `requests` / `pandas`，在 harness sandbox 里大概率 `ModuleNotFoundError`——真联网要用 http-request 节点或 plugin。
2. **工具要有 key。** `tavily_search`（DeepResearch / GPT-Researcher 里真正联网那一步）需要
   `TAVILY_API_KEY`；`json_process.parse` 是内置、免配置；`wikipedia_search` 免 key；
   `podcast_audio_generator` 是 Dify 自家插件，native 上会被 `rejected`。
3. **模型名是原作者的。** `claude-3-5-sonnet-20240620`、`gpt-4o`、`deepseek-reasoner` 只是请求，
   host profile 会换成你自己的；但 prompt 是按 Claude 调的，换本地小模型后结构化输出那段容易崩。
4. **ChatPaper 是 chatflow**（`advanced-chat`），输入是 `paper1`（file，必填）。Dify 会把附件塞进
   `sys.files`，native 不会自己造这个变量 —— 文件内容得当 start 变量显式传。
5. **iteration `is_parallel: true` 语义有差**（GPT-Researcher 里就有）：native 走引擎的 parallel
   combinator，顺序按引擎来，不是 Dify worker pool 的调度。

## 怎么跑

```bash
cd ~/dify-test/dsh-dify-native

# 先看分档，别急着 run
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parseDifyDsl,inspectGraph} from './lib/dsl.js'
const i = inspectGraph(parseDifyDsl(readFileSync('../dsl/research/gpt-researcher.yml','utf8')))
console.log(i.nodeTypes, i.issues, i.support.filter(s=>s.mode!=='full'))"
```

dsh 里则直接调 `dify_native_inspect` / `dify_native_run`，`path` 指本目录绝对路径。

回归：`node tests/research-samples.test.mjs`（把上面每张图的分档和「编译/拒绝」都钉死了）。
本目录**不进** `coverage.test.mjs` —— 那条扫的是 `../dsl/*.yml`（不递归），断言的样本也是它自己列的。

## 顺带修掉的一个 bug

这批图暴露了 `lib/dsl.js` 的一个真问题：Dify 导出的画布备注是
`type: custom-note` 而 `data.type` 是空字符串，原来的 `node?.data?.type ?? node?.type`
对空串不回落，备注全被判成 `generic`，顶着 `passthrough` 进分档、还污染 `unknownKinds`。
现在 `nodeType` 在 `data.type` 为空时回落到外层 `type`，备注正确归一成 `note`。
这也是上面分档数字与「全量 test suite 是否仍绿」一起被验证的原因。
