# 真实运行样例：Dify `translation.yml`（Agentic 翻译）

生成时间：2026-10-17　运行位置：walker server / `difynative` profile / 真实 `ctx.llm`

## 1. 英文 → 中文（country 为空 → if-else 走 true 分支）

输入：

```
source_text = "The best interface is the one you never have to explain. Every tooltip is a small apology for a design decision that was not made."
source_lang = "English"
target_lang = "Chinese"
country     = ""
```

最终输出（`outputs.output`）：

> 最好的界面是不需要解释的。每个提示框，都是对设计不够直观的小小歉意。

中途专家建议（`SUGGESTIONS` 聚合节点，节选）：

> 1. 对于准确度：第二句原文"a design decision that was not made"暗示设计应该足够直观，不需要额外解释，而当前翻译"对设计不周致以的歉意"更侧重于对设计缺陷的道歉，与原文的"未能做出明智设计决策"略有偏差。
> 2. 对于流畅性：整体翻译流畅，但"致以的歉意"表达略显正式和冗长，可以更加简洁。
> 3. 对于风格：原文风格简洁有力，翻译可以进一步精简，保持这种风格特点。

实际执行节点：

```
llm                  TRANSLATION                  ok  route=zai/glm-4.5-air
if-else              COUNTRY IS NULL              ok  route=-/-
llm                  EXPERT_SUGGESTIONS           ok  route=zai/glm-4.5-air
variable-aggregator  SUGGESTIONS                  ok  route=-/-
llm                  IMPORVE_TRANSLATE            ok  route=zai/glm-4.5-air
```

用量：8224 tokens，4 次 agent 调用，72197 ms。

## 2. 英文 → 巴西葡语（country=Brazil → if-else 走 false 分支）

输入：

```
source_text = "We do not need a bigger team; we need fewer handoffs. Every handoff is a place where context goes to die."
source_lang = "English"
target_lang = "Portuguese"
country     = "Brazil"
```

最终输出：

> Não precisamos de uma equipe maior; precisamos de menos handoffs. Cada handoff é um lugar onde o contexto se perde.

专家建议（走的是 `EXPERT_SUGGESTIONS_WITH_COUNTRY` 节点，节选）：

> 1. Accuracy: Consider replacing "passagens de bastão" with "passagens de responsabilidade" or "trocas de responsabilidades" as these are more commonly used in Brazilian business/tech contexts than the sports metaphor.
> 2. Terminology: The term "handoffs" in business contexts is often directly translated as "handoffs" in Brazilian Portuguese, which would be more natural than "passagens de bastão".

用量：4705 tokens，4 次 agent 调用，39510 ms。

## 3. 同一运行时跑其它节点类型（回归）

| 工作流 | 输入 | 输出 | 节点 | 用量 |
| --- | --- | --- | --- | --- |
| `seo-slug.yml` | title = "How to run a mature Dify workflow on a small server without rewriting the harness" | `run-dify-workflow-on-small-server-without-rewriting` | 1×llm | 465 tokens |
| `json-repair.yml` | llm_string = `{a: 1, b: [1, 2,],}` | `{"a": 1, "b": [1, 2]}` | 1×code（landlock partial） | 0 tokens |

## 4. 这些结果能用来干什么

- **直接当翻译工具用**：给长文/技术文案做"初译 → 专家批注 → 按批注重译"的三段式翻译，比单次翻译更能保住语气和术语一致性；`country` 还能让目标语落成某个地区的口语风格。
- **验证 workflow 引擎的节点能力**：这份 yml 同时覆盖 LLM、if-else 分支、变量聚合、结束输出；跑通它等价于证明这套运行时能接更复杂的 Dify 工作流。
- **当作 DSL 兼容层的回归样例**：两条分支各跑一次，就能覆盖 `sourceHandle=true/false`、聚合节点 join、以及分支不执行时的 `undefined` 处理。

完整运行记录（含逐节点 prompt、usage、脚本全文）：`native-translation-true.json`、`native-translation-false.json`。
