# 可复现部署

JavaScript 依赖 `nunjucks`、`yaml`、`ajv` 都在 package.json 直接声明，package-lock.json 固定解析结果。源码检出执行 `npm ci`；打包后在目标插件目录安装依赖或 `npm install /abs/dsh-dify-native-0.2.0.tgz`。不依赖 dsh 安装目录里的 ambient 模块。

## 1. clone 后先装 JS 依赖

```bash
git clone http://127.0.0.1:8443/walker/dsh-dify-native.git
cd dsh-dify-native/dsh-dify-native
npm ci                 # 必须：缺 yaml/ajv/nunjucks 时插件连加载都失败
```

`npm pack` 包含 lib（含 Python helper）、requirements-extraction.txt、requirements-events.txt、scripts、docs 和 cordis.patch.yml。

## 2. 可选 Python 依赖

以下脚本相对插件安装根目录执行：

```bash
./scripts/install-extraction.sh
./scripts/install-events.sh
```

两个安装目标默认是插件新目录 `.vendor-extraction`、`.vendor-events`。若已存在，脚本拒绝覆盖；更新时选择新目录（例如 DIFY_EXTRACTION_VENDOR=/new/path）或自行准备独立 Python 环境。解释器用 DIFY_RUNTIME_PYTHON；已有依赖可用 DIFY_EXTRACTION_VENDOR、DIFY_EVENTS_VENDOR、DIFY_PYTHONPATH 指向。运行 helper 自动组合这些路径，不改变全局 Python、用户原 vendor 或配置。不安装 unstructured，旧格式缺转换链明确报错；缺库错误会给安装命令。

提取依赖包括固定官方 pypdfium2==4.30.0、python-docx==1.1.2、pandas==2.2.3/openpyxl==3.1.5；依赖体积与普通文本读取不同，仍由用户显式选择安装。croniter==6.2.4 只用于事件定时桥。code 样本另需原环境的 json_repair/requests/jieba，与提取/调度目录分别配置。

真实执行还需安装 dsh，装载 session/tools/subagent/PTC runtime/workflow engine、sandbox、模型路由等服务；本插件不会用 mock 引擎替代缺失服务。安装依赖不等于外部模型、插件、知识库或账户已经可用。

`tests/package-deployment.test.mjs` 在 /tmp 独立目录 npm pack → npm install --ignore-scripts → 新 Node 进程 import，并断言三个依赖都从该临时 node_modules 解析。随后用显式 Python 依赖路径运行打包后的 PDF helper 与 cron helper，不重复安装 Python 大包。通过时输出 CLEAN PACKAGE IMPORT OK / PACKAGE DEPLOYMENT OK。测试需 npm registry 网络，失败会使全量测试失败，不 skip。
