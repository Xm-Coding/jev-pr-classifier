# jev-pr-classifier
Classifying code PR into certain types by JEV model

这是一个 PR 单分类原型：输入 GitHub、Gitee、GitCode 或 AtomGit 的公开 PR 链接，服务端读取标题、描述和改动文件，调用 TypeSafe Jev 官方 API；网页显示一个主要类别、七类概率及 API 返回的 confidence。

固定类别为：修复缺陷、增加特性、示例/教程、功能测试、代码重构、运行环境、代码增强。首版定义和边界在 `lib/rubric.ts`；这是待用平台样本验证的初始口径。混合 PR 按主要目的归类，功能或修复附带的文档/测试不单独改变主类别。

**本次真实联调的限制：**当前本机向 TypeSafe 发出的请求返回 HTTP 451，响应说明 `Typesafe is not available in your region.`，因此未取得真实分类概率，也不能据此认定 API key 无效。原型会显示该错误，成功路径没有接入演示数据。代码、模拟契约测试和真实 PR 内容读取仍可验证。API 调用可用性需要在 TypeSafe 支持的服务环境和账户条件下确认。

2026-10-14 复核：Higress PR #5079 可以完整读取标题、描述及 6 个文件的 diff；本机 TypeSafe 请求仍返回 451。托管站点从本机 curl 访问被 Cloudflare 网关以 403 拒绝，无法由本机验证托管推理结果；这个网络路径与用户浏览器不是同一条，不能认定用户错误也是 403。查询到的生产 Worker 日志只显示页面和配置检查成功，尚无分类请求记录。

网页现在分别处理浏览器连接失败、登录跳转、网关非 JSON 响应和模型错误，显示错误码和请求编号，不再直接展示 `Failed to fetch`。登录跳转使用正常顶层导航；服务访问权限不变。`/api/status` 现在会从服务器对配置的模型发出一次很小的真实推理请求，校验响应结构和实际版本；同一 Worker isolate 内缓存 60 秒。它消耗少量输入 tokens，验证模型调用与账户权限，不代表具体 PR 分类已成功。分类请求日志只记录状态、错误码、阶段和请求编号，不记录 Key 或 PR 内容。

排查发现托管代码使用 `redirect: "error"`，在本项目 Cloudflare Worker 运行时（2026-05-15 兼容日期）会直接抛出 `Invalid redirect value`，请求尚未发出。已把源平台与 TypeSafe 请求改为 `manual`；3xx 作为错误处理，禁止自动转发服务端凭据。增加真实 workerd 运行时契约验证，避免仅在 Node.js 中测试导致遗漏。

2026-10-15 继续验证：修复后托管服务器已能访问 TypeSafe（模型接口 200），线上分类请求随后失败于 GitHub API 读取限制。现在匿名 GitHub API 被拒绝时，会尝试直接读取公开 PR 网页和 GitHub 公开净 diff；不向这些地址发送任何令牌。页面内嵌元数据须匹配仓库与 PR 编号。备用来源的描述来自渲染文本，未验证的 API 元数据会明确告警并始终建议人工复核；公开页面也不可用时仍报告源平台错误。正式平台应优先使用已有 PR 数据，或配置专用 GitHub 访问凭据，以获得稳定读取与更高额度。

本地运行需要 Node.js 24（项目测试使用 Node 的原生 TypeScript 支持）。执行：

```sh
npm install
read -s 'TYPESAFE_API_KEY?Jev API key: '
export TYPESAFE_API_KEY
export TYPESAFE_MODEL=jev-1.14.0
npm run dev
```

上面的隐藏输入写法适用于 macOS 默认 zsh。也可用其他密钥管理方式设置环境变量；不要把密钥加入前端代码或 Git。网页地址为 `http://127.0.0.1:5173/`，本地 API 监听 `127.0.0.1:8788`。Vite 代理 `/api/` 到本地 API，因此浏览器无需持有 Jev 密钥。Ctrl+C 停止开发服务。

`scripts/with-secrets.mjs` 为自动化提供隐藏 stdin 输入模式，可用于 `check`、`live-test`、`dev`。它不把凭据写入磁盘或命令行。公开 PR 默认不需要源平台令牌；私有仓库或更高频读取可在服务端配置 `GITHUB_TOKEN`、`GITEE_TOKEN`、`GITCODE_TOKEN`、`ATOMGIT_TOKEN`。这些令牌仅发送给对应平台 API。

```sh
npm test
npm run typecheck
npm run build
```

生产构建使用 Vinext / Cloudflare Workers，`app/api/classify/route.ts` 从运行时环境读取服务端密钥。托管时需要把 `TYPESAFE_API_KEY` 配成 secret。`.openai/hosting.json` 只包含 Site 身份与部署配置，不包含密钥。

公开示例链接：

- GitHub：`https://github.com/psf/requests/pull/7628`
- Gitee：`https://gitee.com/dromara/sa-token/pulls/378`
- GitCode：`https://gitcode.com/openeuler/docs/merge_requests/635`
- AtomGit：`https://atomgit.com/openeuler/docs/merge_requests/635`

这些链接读取的是实时远程数据，仓库访问状态或平台限流会变化。Gitee 和 GitCode/AtomGit 的 `patch` 可能是含 `diff` 的对象；文件接口不使用 GitHub 的分页方法。原型对 GitHub 分页读取，最多保留 300 个文件。缺失文本 diff、文件清单不全或输入截取都会显示提示。

处理 PR 时移除无效控制字符和描述中的 HTML 注释，保留代码注释、文档和字符串作为分类证据；通过固定问题把 PR 数据与分类规则分开。清洗与提示规则只能降低输入干扰，不能保证免疫提示注入。不会执行 PR 中的代码。标题、描述、路径和 diff 经 JSON 序列化放入 `state`，分类问题和七类定义放入 `questions.pr_category.instructions` 与 `criteria`。

请求使用 `POST https://api.typesafe.ai/v1/systemone`，服务端 Bearer 鉴权，当前固定模型 `jev-1.14.0`。页面直接采用 `choice`、`probabilities` 和 `confidence`，不会自行补造、重归一化或根据文字生成概率。[官方 API](https://docs.typesafe.ai/api)、[模型与限制](https://docs.typesafe.ai/models)、[介绍](https://docs.typesafe.ai/introduction)。

Choice confidence 的官方公式是 `(p_max - 1/n) / (1 - 1/n)`。这里固定七类，最高类别概率 87% 对应 confidence 约 84.83%；confidence 87% 对应最高概率约 88.86%。它描述概率分布集中程度，不能直接解释为业务判断正确率。[官方置信度说明](https://docs.typesafe.ai/confidence)。

页面中的 85% 门限只是可调整的试验值，不改变原始 API 数据，也不会自动审核 PR。输入不完整或使用长上下文时始终显示复核建议。正式使用应把现有数据划分为规则开发、门限选择和最终测试三部分，保证同一 PR 的不同快照及近重复记录不跨集合；人工核验已有标签，按类别统计准确率、自动分类覆盖率和被接受样本的错误率，再分别选择模型版本与类别门限。API 故障应重试或保留失败状态，不能伪装成低 confidence 分类。

关键文件：

- `lib/rubric.ts`：七类定义和分类指令。
- `lib/pr-source.ts`：链接验证、各平台读取、diff 归一化。
- `lib/classifier.ts`：输入预算、Jev 调用、响应验证与错误处理。
- `app/classifier-ui.tsx`：中文表单、概率条、confidence 和 PR 信息。
- `tests/classifier.test.mjs`：跨平台格式、分页、输入预算、凭据隔离、响应契约及地区错误测试。

输入预算采用保守的 UTF-8 字节上限，不依赖未经验证的 token 估算。大 PR 的 diff 会按预算截取，原始 API confidence 不会因此被人为降低，页面另外标出输入不完整。正式平台接入可把已存储的完整 PR 数据接入 `prepareState` 与 `callJev`，无需重复爬取链接。

2026-10-15 模型升级：固定使用 `jev-1.14.0`。官方文档列出的最新版于 10 月 14 日发布，`jev-preview` 指向 1.14，`jev-latest` 仍指向 1.13；固定编号避免别名变化影响评测。两版默认均为每请求 64k tokens、每问题 32k tokens；发送 `TypeSafe-Danger-Zone-Long-Context: true` 后两项均为 262k tokens。长上下文按相同 token 单价计费，但官方提示会更慢且准确率下降。

应用采用自动模式：完整 JSON 请求在 28,000 UTF-8 字节以内不加长上下文请求头；超过后启用长上下文，应用保守上限为 224,000 字节。这些是应用的字节预算，不是模型 token 上限，也不意味着已验证 262k tokens 的完整容量。预算内完整保留已读取的标题、描述和 diff，取消原先每文件 6 KB 的额外截取；超过应用预算仍暂按文件分配并截取，明确警告并要求复核。语义证据筛选与恶意注释隔离尚未实现，读取端 300 文件等限制仍存在。

批量分析：页面可切换“单个 PR / 批量 PR”。批量模式每行输入一个链接，支持混合 GitHub、Gitee、GitCode 与 AtomGit。提交前使用与服务端一致的链接规则校验，移除重复链接并列出无效行；每批最多 50 个有效且不同的 PR，当前批次最多并发 2 个。每个 PR 独立调用现有 `/api/classify`，独立显示进度、主要类别、confidence、复核建议和错误；可展开成功项查看七类原始概率。

失败或停止等待的条目可单独组成重试队列，已成功项不会再次提交。停止批次会停止派发新任务并中止浏览器等待，但已经发出的服务端推理可能继续，重试可能再次调用模型。队列和结果只保存在当前页面内存中，需保持页面打开；刷新、切换模式或开始新批次会清除或替换当前批次结果。它不提供后台持久任务服务，也不限制其他浏览器会话的并发量。

CSV 导出包含当前所有条目的状态、成功项七类概率与 confidence 原始数值（0–1）、试验门限和复核建议，以及失败项的错误码、说明和请求编号；没有结果的字段留空，不伪造零概率。外部字符串会经过 CSV 引号转义及常见电子表格公式前缀保护。CSV 与浏览器结果均不包含 API key。
