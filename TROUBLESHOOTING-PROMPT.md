# dsh-llm-proxy 排查指导（给大模型）

> 把本文档完整交给 DSH 中的任意一个具备工具权限（可执行命令、读取文件）的大模型，
> 它会在这台机器上自主排查 `@superfish058/dsh-llm-proxy` 插件为什么不能用，
> 并产出一份结构化 JSON 报告。
>
> **原则：不预设本机配置**——代理地址、端口、供应商、模型、API Key 一律从
> 这台机器上读到的实际配置出发，排查结论必须基于实际证据。

---

## 一、背景

这是一个 DSH 的模型代理插件：让 LLM 请求按模型走代理（代理地址由用户在自己
机器上配置），未勾选的模型保持直连。现在插件"不能用"——可能表现为对话超时、
不走代理、设置卡不显示、测试连接失败等。

## 二、你的角色

你是 DSH 环境中的 AI 助手，有工具访问权限（可执行命令、读取文件）。请在这台
机器上自主排查，无需用户手动提供任何信息。**必须从这台机器的实际配置出发，
不要假定任何默认端口、供应商或模型。**

## 三、排查步骤（按顺序执行，每步记录命令、输出、结论）

### 第 1 步 读取实际配置

- `node --version` 记录 Node 版本；`dsh --version` 记录 DSH 版本
- 读取 `~/.dsh/profiles/<profile>/cordis.patch.yml`（dsh ≤ 0.1.6 时代在 `~/.dsh/settings.yaml`），找到 `llm-proxy` 那一行，记录实际配置的：
  - `proxyHost` / `proxyPort`（以这里的值为准）
  - `proxiedModels`
  - `retries` / `retryIntervalMs`
- 读取 `~/.dsh/cordis.patch.yml`，确认插件是否已加入 patch 配置
- 找到 `llm-pi-ai.providers` 和 `llm-deepseek` 节，列出这台机器**实际配置了
  哪些 provider**（不要假设有哪些）

### 第 2 步 插件安装状态

- 运行 `dsh plugin --profile web list`，确认插件在列表中
- 在 `~/.dsh` 下搜索 dsh-llm-proxy 相关文件，确认 bundle 是否正确注入

### 第 3 步 dsh web 日志检查

- 查找 DSH 日志（通常在 `~/.dsh/` 或 dsh web 启动输出中）
- 搜索 `dsh-llm-proxy` 关键词，重点检查：
  - 是否打印 `engine=official` / `engine=bundled`，以及随后的 `official policy installed` 或 `global dispatcher → RoutingDispatcher`
  - 该行 `proxy=...` 是否为用户实际配置的地址
  - `proxiedHosts=[...]` 是否非空
  - 是否有 `error` / `warn` / `failed`
- 找不到日志就尝试定位 dsh web 进程（`ps` / `tasklist`）再看其输出

### 第 4 步 代理连通性测试

- 用第 1 步读到的 `proxyHost` / `proxyPort` 测试（把 `<HOST>` / `<PORT>`
  换成实际值）：

  ```bash
  curl -x http://<HOST>:<PORT> -s -o /dev/null -w "%{http_code}" https://www.google.com
  ```

- 再测一次直连（不走代理）：

  ```bash
  curl -s -o /dev/null -w "%{http_code}" https://www.google.com
  ```

- 通过对比判断是以下哪种：**代理不可达** / **代理可达但目标走代理失败** / **本机根本没网**

### 第 5 步 模型与路由检查

- 把 `proxiedModels` 里每个 key 与设置卡实际渲染的模型列表核对（key 必须是
  `<providerId>/<modelId>`；providerId 是这台机器 `llm-pi-ai` 里实际存在的
  provider ID，模型 ID 是实际配置的模型）
- 确认这些模型的 baseURL host 与日志中 `proxiedHosts` 一致

### 第 6 步 API Key 验证

- 对每个走代理的 provider，确认密钥来源存在且完整：
  1. 优先内联 `apiKey`
  2. 其次 `apiKeyEnv` 指向的环境变量（`echo $<变量名>`）
  3. 其次 `$DSH_HOME/.credentials.yaml` 里对应的 refs 条目
- 只判断"存在且非空"，不要假定具体变量名或 key 前缀规则，除非该 provider
  官方有明确格式

### 第 7 步 设置页功能验证

- 访问 DSH 设置 → 插件 → 可配置插件 → 模型代理
- 确认设置卡是否显示（不显示 → 客户端 bundle 注入失败）
- 确认「测试连接」按钮可用；点一次，记录返回结果（成功或具体失败原因）

### 第 8 步 版本兼容性核对（只做核对，不做预设）

- DSH 版本 vs 插件版本：插件 v1.0.7 起适配 DSH 新版设置槽位（keyed slot）；
  若 DSH 较新而插件很旧，可能加载失败——以实际版本核对
- 插件要求 Node >= 24：若 `node --version` 低于 24，如实指出
- 排查中**实际遇到**报错信息时按报错内容判断；不要仅凭猜测引入与这台机器
  无关的问题

## 四、必须产出的结构化成果

排查完成后输出 JSON 报告，**每一项都填写，不可跳过**：

```json
{
  "环境": {
    "操作系统": "实际值",
    "Node.js 版本": "实际值",
    "DSH 版本": "实际值",
    "插件版本": "实际值"
  },
  "实际配置": {
    "proxyHost": "从配置读取的实际值",
    "proxyPort": 从配置读取的实际值,
    "proxiedModels": ["实际 key 列表"],
    "retries": 实际值,
    "本机配置的 providers": ["providerId 列表"]
  },
  "插件状态": {
    "是否已安装": "是/否",
    "设置卡是否显示": "是/否/描述",
    "日志 global dispatcher 行": "有/无 — 内容摘要",
    "日志中 proxy= 是否等于实际配置": "是/否",
    "proxiedHosts 是否非空": "是/否 — host 列表",
    "是否有错误/警告": "有/无 — 内容"
  },
  "每步检查记录": [
    { "步骤": "读取实际配置", "命令": "…", "输出": "…", "结论": "正常/异常" }
  ],
  "代理连通性": {
    "经代理访问外网": "成功/失败 — 状态码或错误",
    "直连访问外网": "成功/失败 — 状态码或错误"
  },
  "API Key 状态": "按 provider 列出：有效/缺失/格式异常",
  "根因判断": "一句话说明插件不能用的主要原因",
  "修复方案": ["步骤1…", "步骤2…", "步骤3…"],
  "复验建议": "修复后如何验证"
}
```

## 五、注意事项

- 某步执行失败 / 文件不存在 / 权限不足时，如实记录"无法执行"，不要跳过整个步骤
- 不要修改任何配置；即使有把握修复，也要先在报告中说明，等用户确认后再动手
- 若确认是 DSH 内核或插件自身缺陷导致无法修复，如实说明限制即可
- 最终输出必须是完整 JSON 报告，包含全部字段
