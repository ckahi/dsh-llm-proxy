# dsh-llm-proxy 排查指南（给对面大模型与使用者）

> 本文档用于指导在 **DSH 环境**中，当 `@superfish058/dsh-llm-proxy` 插件下载后"不能用"时，**你（使用者）** 如何快速自检，以及如何 **让 DSH 里另一个大模型** 帮你自动化排查，并产出结构化排查成果。
>
> ⚠️ **本指南不预设你的任何配置**：代理地址、代理端口、供应商、模型、API Key 都**以你本机的实际配置为准**，排查的第一步永远是"读取你的实际配置"，而不是套用任何写死的值。

---

## 一、使用者快速自检清单

插件"不能用"（勾选了模型但对话超时、不走代理、设置卡不显示、测试连接失败等）时，按顺序自检，**卡在哪一步就对照后面的"常见症状对照表"**。

### □ 1. 确认插件已安装

```bash
dsh plugin --profile web list
```

输出中应包含 `@superfish058/dsh-llm-proxy`。没有则先安装：

```bash
dsh plugin --profile web add @superfish058/dsh-llm-proxy
```

### □ 2. 确认已重启 dsh web

安装后必须**退出 DSH 托盘 → 重新启动**。仅刷新网页无效。重启后日志应出现：

```
# dsh ≥ 0.1.3（官方出站代理包在）→ 官方引擎
dsh-llm-proxy: engine=official — official outbound-proxy package detected (...)
dsh-llm-proxy: official policy installed (engine=official, proxy=<你的host>:<你的port>, proxiedHosts=[...], directHosts=[...])

# dsh ≤ 0.1.2（没有官方包）→ 自带 dispatcher
dsh-llm-proxy: engine=bundled — official outbound-proxy package not found, using the built-in dispatcher
dsh-llm-proxy: global dispatcher → RoutingDispatcher (engine=bundled, proxy=<你的host>:<你的port>, proxiedHosts=[...])
```

### □ 3. 确认设置卡正常显示

进入 **设置 → 插件 → 可配置插件 → 模型代理**，应看到完整配置表单（代理地址、走代理模型列表、多模态模型、重试次数）。

### □ 4. 读取你的实际代理地址，并用它测连通

打开设置卡（或 `~/.dsh/settings.yaml` 的 `llm-proxy:` 节），记下你实际配置的 `proxyHost` 和 `proxyPort`（**这是你自己配的，可能是任何端口，别用网上的默认值猜**）。然后用这个地址测试：

```bash
# 把 <HOST> 和 <PORT> 换成你配置里的实际值
curl -x http://<HOST>:<PORT> -s -o /dev/null -w "%{http_code}" https://www.google.com
```

返回 `200` = 代理可用；返回 `000`/超时/连接拒绝 = 代理没运行、端口不对、或代理软件没在监听。

### □ 5. 确认模型已勾选并保存

在设置卡"走代理的模型"列表里勾选你要走代理的模型（列表内容来自**你本机**的供应商与模型配置），然后**点击保存**。注意：**「测试连接」读的是已保存的配置**，改勾选后必须先保存再测试。

### □ 6. 用「测试连接」按钮验证

每行模型右侧有「测试连接」按钮，点击后应显示：

- ✅ **连接成功**：`200 · 38ms · 经代理 · 多模态已开启`
- ❌ **连接失败**：直接显示具体原因（认证失败、超时、限流、404 等），一眼定位

### □ 7. 真实对话测试

在对话中选一个已勾选的模型发一条消息，应正常响应；是否真的走了代理，可在**你自己的代理软件日志**里确认。

---

## 二、给对面大模型的排查任务书（可整段复制粘贴）

DSH 里另一个大模型（如有工具权限，可执行命令、读文件）**把下面这段话完整粘贴给它**，它会自动在你机器上排查并产出结构化报告。**所有检查都读取你机器上的实际配置，不预设任何值。**

```
# 任务：排查 DSH 插件 @superfish058/dsh-llm-proxy 故障

## 背景
这是一个 DSH 的模型代理插件：让 LLM 请求按模型走代理（代理地址由用户在自己机器上配置），未勾选的模型保持直连。现在插件"不能用"——可能表现为对话超时、不走代理、设置卡不显示、测试连接失败等。

## 你的角色
你是 DSH 环境中的 AI 助手，有工具访问权限（可执行命令、读取文件）。请在这台机器上自主排查，无需用户手动提供任何信息。**必须从这台机器的实际配置出发，不要假定任何默认端口、供应商或模型。**

## 排查步骤（按顺序执行，每步记录命令、输出、结论）

### 第 1 步：读取实际配置
- `node --version` 记录 Node 版本；`dsh --version` 记录 DSH 版本
- 读取 `~/.dsh/settings.yaml`，找到 `llm-proxy:` 节，记录用户实际配置的：
  - `proxyHost` / `proxyPort`（代理地址，这是用户自己配的，以这里的值为准）
  - `proxiedModels`（走代理的模型 key，格式为 <providerId>/<modelId>）
  - `multimodalModels` / `retries` / `retryIntervalMs`
- 读取 `~/.dsh/cordis.patch.yml`，确认插件是否已加入 patch 配置
- 找到 `llm-pi-ai.providers` 和 `llm-deepseek` 节，列出**这台机器实际配置了哪些 provider**（不要假设有哪些）

### 第 2 步：插件安装状态
- 运行 `dsh plugin --profile web list`，确认插件是否在列表中
- 在 `~/.dsh` 下搜索 dsh-llm-proxy 相关文件，确认 bundle 是否正确注入

### 第 3 步：dsh web 日志检查
- 查找 DSH 日志（通常在 ~/.dsh/ 或 dsh web 启动输出中）
- 搜索 `dsh-llm-proxy` 关键词，重点：
  - 启动时是否打印 `engine=official` 或 `engine=bundled`（决定走哪条链路），随后是否有 `official policy installed` / `global dispatcher → RoutingDispatcher`
  - 该行中 `proxy=...` 显示的是不是用户实际配置的地址
  - `proxiedHosts=[...]` 是否非空
  - 是否有 error/warn/failed
- 找不到日志就尝试定位 dsh web 进程（ps / tasklist）再看其输出

### 第 4 步：代理连通性测试
- 用第 1 步读到的 `proxyHost` / `proxyPort` 测试（把 <HOST>/<PORT> 换成实际值）：
  - `curl -x http://<HOST>:<PORT> -s -o /dev/null -w "%{http_code}" https://www.google.com`
- 再测一次**直连**（不走代理）：`curl -s -o /dev/null -w "%{http_code}" https://www.google.com`
- 通过对比判断：是"代理不可达"，还是"代理可达但目标走代理失败"，还是"本机根本没网"

### 第 5 步：模型与路由检查
- 把 `proxiedModels` 里的每个 key 与设置卡实际渲染的模型列表核对（key 必须是 <providerId>/<modelId>，providerId 是这台机器 llm-pi-ai 里实际存在的 provider ID，模型 ID 是实际配置的模型）
- 确认这些模型的 baseURL host 与日志中 `proxiedHosts` 一致（一个 key 命中 → 其 baseURL 的域名进 proxiedHosts）

### 第 6 步：API Key 验证
- 对每个走代理的 provider，确认密钥来源存在且完整：
  - 优先内联 `apiKey`
  - 其次 `apiKeyEnv` 指向的环境变量（`echo $<变量名>`）
  - 其次 `$DSH_HOME/.credentials.yaml` 里对应的 refs 条目
- 只判断"存在且非空"，不要假定具体的变量名或 key 前缀规则，除非该 provider 官方有明确格式

### 第 7 步：设置页功能验证
- 访问 DSH 设置 → 插件 → 可配置插件 → 模型代理
- 确认设置卡是否显示（不显示 → 客户端 bundle 注入失败）
- 确认「测试连接」按钮可用；点一次，记录返回结果（成功或具体失败原因）

### 第 8 步：版本兼容性核对（只做"核对"，不做预设）
- DSH 版本 vs 插件版本：插件 v1.0.7 起适配 DSH 新版设置槽位（keyed slot）；若 DSH 较新而插件很旧，可能加载失败——以 dsh --version 和插件实际版本核对
- 插件要求 Node >= 24：若 node --version 低于 24，属不满足要求，应如实指出
- 如果你在排查中**实际遇到**报错信息，按报错内容判断；**不要仅凭猜测引入与这台机器无关的问题**

## 必须产出的结构化成果
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
    "multimodalModels": ["实际 key 列表"],
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
  "API Key 状态": "按 provider 列出：有效/缺失/格式异常（如确有官方格式要求）",
  "根因判断": "一句话说明插件不能用的主要原因",
  "修复方案": ["步骤1…", "步骤2…", "步骤3…"],
  "复验建议": "修复后如何验证（如：重启 dsh web → 看日志 → 测试连接 → 对话测试）"
}
```

## 注意事项
- 某步执行失败/文件不存在/权限不足时，如实记录"无法执行"，不要跳过整个步骤
- 不要修改任何配置；即使有把握修复，也要先在报告中说明，等用户确认后再动手
- 若确认是 DSH 内核或插件自身缺陷导致无法修复，如实说明限制即可
- 最终输出必须是完整 JSON 报告，包含全部字段
```

---

## 三、常见症状对照表

> 表中所有"代理地址"均指**用户本机实际配置的 proxyHost:proxyPort**，以设置卡 / settings.yaml 里的值为准。

| 症状 | 可能原因 | 验证方法 | 修复 |
|---|---|---|---|
| 日志无 dsh-llm-proxy 输出 | 插件未安装 / 未重启 | `dsh plugin --profile web list` | 安装后重启 dsh web |
| 日志 proxiedHosts=[]（空） | proxiedModels 的 key 拼错 / provider 命名空间未注册 / 没保存 | 核对 settings.yaml 里 key 与设置卡列表 | 用设置卡列表里的 key 重新勾选并保存 |
| 日志 proxy= 显示的不是你配置的地址 | 配置未保存生效 / 改了配置没保存 | 对照 settings.yaml | 保存后重看日志；必要时重启 |
| 设置卡"一直加载中" | 客户端 bundle 注入失败 / 插件版本过旧 | 看浏览器控制台错误 | 升级插件到最新版 |
| 设置卡不显示 | 插件未安装 / 未重启 / 版本不兼容 | 检查插件列表与 DSH 版本 | 重启；核对插件版本与 DSH 版本兼容性 |
| 测试连接超时（20s） | 代理不可达 / 模型没勾选（直连不通） | 用实际代理地址 curl 外网；对比直连结果 | 启动/修正代理；勾选模型后保存；核对代理地址 |
| 测试连接 401/403 | API Key 无效或未配置 | 检查该 provider 的 apiKey / apiKeyEnv / .credentials.yaml | 配置正确密钥后重测 |
| 测试连接 404 | baseURL 或模型 ID 错误 | 核对 provider baseURL 与模型 ID | 按该 provider 官方文档修正 |
| 测试连接 429 | 触发限流 | 查看错误 body | 等限流窗口；降低频率；调大 retries |
| 测试连接 400 | 探测参数被提供方拒绝 | 查看错误 body 具体提示 | 按提示调整（如提供方对 max_tokens 有下限） |
| 对话超时（境外模型） | 该模型没勾选走代理，直连不通 | 测试连接看是否超时 | 勾选该模型并保存 |
| 间歇性超时 | undici 代理连接池 keep-alive 复用死连接 | 观察是否偶发挂起后自动重试成功 | 升级到 v1.1.0（已修复）；仍有问题再反馈 |
| 只部分模型走代理 | 部分 key 没勾或拼错 | 逐个核对设置卡列表 | 勾齐所有需要走代理的模型 |
| 代理地址端口被占用 / 代理软件没监听 | 代理软件未启动或端口冲突 | 用实际地址 curl 测试 | 启动代理软件；换端口或关冲突进程 |
| Windows 防火墙拦截 | 出站规则限制代理软件 | 临时关闭防火墙复测 | 加防火墙放行规则 |
| Node 版本低于 24 | 插件 engines 要求 Node>=24 | `node --version` | 升级 Node 到 >=24 |

---

## 四、成果验收清单

收到排查大模型的报告后，确认包含全部内容：

- [ ] **环境信息**：操作系统、Node 版本、DSH 版本、插件版本
- [ ] **实际配置**：从你机器读出的 proxyHost/proxyPort、proxiedModels、multimodalModels、retries、实际 providers（而非任何默认值）
- [ ] **插件安装与设置卡状态**
- [ ] **日志核查**：global dispatcher 行、proxy= 是否等于实际配置、proxiedHosts 是否非空
- [ ] **每步检查记录**：命令、实际输出、结论
- [ ] **代理连通性**：经代理 vs 直连的对比结果
- [ ] **API Key 状态**：按 provider 列出
- [ ] **根因判断** + **修复方案**（可执行、按顺序）+ **复验建议**

缺任何一项，可让排查大模型补充。

---

## 五、修复后如何复验

1. **重启 dsh web**（退出托盘重新启动）
2. **看日志**：global dispatcher 行的 `proxy=` 等于你的实际配置，且 `proxiedHosts` 非空
3. **测试连接**：设置页点「测试连接」，确认 ✅ 连接成功
4. **对话测试**：选走代理的模型发消息，正常响应
5. **代理日志确认**：在**你自己的代理软件**日志里确认流量经过

---

## 附录：关于"模型 key"的说明

- `proxiedModels` 里的 key 必须是 **<providerId>/<modelId>**。
- providerId 是这台机器 `llm-pi-ai.providers` 里**实际存在的** provider ID（每个人可能不同，可能叫任何名字）。
- 最稳妥的取法：**直接复制设置卡"走代理的模型"下拉列表里的值**，不要自己拼。
- 一个 key 命中后，该模型 baseURL 的域名会被加入 `proxiedHosts`；同一域名下的其他模型随之一起走代理（按 API 地址整组生效）。

---

## 附录：插件版本兼容性参考

| 版本 | 主要特性 | 兼容性说明 |
|---|---|---|
| v1.0.0–v1.0.3 | 按模型走代理 + 重试 + 目录回退 | 旧 DSH 可用 |
| v1.0.7 | 适配 DSH 新版设置槽位（keyed slot） | **DSH 较新版本需 ≥ v1.0.7** |
| v1.0.9 | 多模态镜像 + 加载中修复 | 建议升级 |
| **v1.1.0** | 测试连接按钮 + 连接池修复 | **建议升级到最新版** |

> 用 `dsh --version` 与插件版本核对；升级命令：`dsh plugin --profile web add @superfish058/dsh-llm-proxy`（再重启 dsh web）。
