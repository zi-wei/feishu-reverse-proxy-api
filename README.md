# 飞书反代 API

将当前登录账号可访问的飞书助手接入支持 OpenAI Chat Completions 的客户端.

## Windows 分发版

1. 解压 `aily-openai-windows-x64.zip`, 不要直接在压缩包内运行.
2. 双击 `Connect to Feishu.cmd`.
3. 首次使用时, 在自动打开的 Chrome 或 Edge 中扫码登录自己的飞书账号.
4. 工具自动识别该账号可用的工作伙伴助手, 启动本地网关并打开连接配置页.
5. 在配置页复制 Base URL, API Key 和模型名, 填入支持 OpenAI Chat Completions 的客户端.

需要指定“安服小助手‘乐乐’（multi-agent）”时, 双击 `Connect to Lele.cmd`. 工具会验证当前飞书账号是否有权访问 `agent_4kgf4uygwpt75n5`; 无权限时不会切换配置. 乐乐已验证支持普通对话和强制外部工具调用; 它的飞书内置工具仍由飞书自身执行.

每个人在自己的 Windows 电脑执行以上步骤. 每个实例使用该用户自己的飞书身份, 权限和额度. 登录凭据与 API Key 保存在 `%LOCALAPPDATA%\AilyOpenAI`, 并通过 Windows DPAPI CurrentUser 加密. 分发包本身不包含构建者的账号数据或 API Key.

需要切换账号时双击 `Reconnect Account.cmd`. 电脑重启后双击 `Start Gateway.cmd`; 需要重新查看配置时再次双击 `Connect to Feishu.cmd`. 停止服务时双击 `Stop Gateway.cmd`.

系统要求: Windows 10/11 x64, Microsoft Edge 或 Google Chrome, 可访问飞书网站. Windows 分发包已携带 Node.js 运行时和程序依赖, 不要求用户安装 Node.js, Codex 或开发工具.

## Linux 分发版

1. 下载 `feishu-reverse-proxy-api-linux-x64.tar.gz`, 解压到用户有写权限的目录.
2. 在解压目录执行 `./connect-feishu.sh`, 或执行 `./connect-lele.sh` 连接乐乐.
3. 首次使用时, 在自动打开的 Chrome 或 Chromium 中扫码登录自己的飞书账号.
4. 工具自动启动本地网关并显示连接配置页. 将 Base URL, API Key 和模型名填入支持 OpenAI Chat Completions 的客户端.

Linux 版本使用 `$HOME/.local/state/aily-openai` 保存配置, 凭据文件权限为 `0600`, 不依赖 Windows DPAPI. 系统需要 x86_64 Linux, glibc 2.28 或更高版本, Chrome 或 Chromium, 以及 `xdg-open`.

需要切换账号时执行 `./reconnect-account.sh`. 系统重启后执行 `./start-gateway.sh`; 需要重新查看配置时再次执行 `./connect-feishu.sh`. 停止服务时执行 `./stop-gateway.sh`. Linux 分发包已携带 Linux x64 Node.js 运行时和程序依赖.

## 配置客户端

1. 执行 `aily-openai config`, 查看连接地址和本地 API Key.
2. 选择 OpenAI 兼容提供商, 将 Base URL 填为 `http://127.0.0.1:8765/v1`.
3. 填入返回的 API Key, 将模型名设为 `aily-assistant`.
4. 使用 Chat Completions 模式. 需要外部工具时, 在客户端启用该自定义模型的工具调用能力, 并配置要使用的工具或 MCP 服务.
5. 保持图片输入和 JSON Schema 回复格式关闭. 外部工具参数中的 JSON Schema 可以正常使用.

仅在客户端要求完整请求地址时填写 `http://127.0.0.1:8765/v1/chat/completions`.

## 管理服务

```powershell
aily-openai start
aily-openai status
aily-openai doctor
aily-openai config
aily-openai stop
aily-openai --help
```

- 电脑重启后执行 `aily-openai start`.
- 端口占用时执行 `aily-openai start --port 8766`, 并同步更新客户端地址.
- 登录失效时依次执行 `aily-openai stop`, `aily-openai login`, `aily-openai start`. 在弹出的浏览器里完成登录.
- 便携版使用压缩包内的 `runtime\node.exe`, 不要单独移动或删除 `runtime` 和 `app` 目录.
- 登录配置保存在 `%LOCALAPPDATA%\AilyOpenAI`, 调整配置后重启服务.

## 接口约定

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 查询本地服务是否运行 |
| `GET /v1/models` | 获取可用模型 |
| `GET /v1/models/aily-assistant` | 查询模型 |
| `POST /v1/chat/completions` | 普通 JSON 或 `stream: true` 的 SSE 回复 |

- 为 `/v1/` 请求携带 `Authorization: Bearer <本地 API Key>`.
- 发送文本 `messages`, 支持 `system`, `developer`, `user`, `assistant`, `tool` 角色和 `type: text` 内容数组.
- 新对话会在飞书创建任务. 携带完全匹配的历史消息续聊时, 网关复用该任务. 修改历史, 分支续聊或在网页修改任务后, 网关使用完整历史创建新任务.
- 将角色标签作为对话上下文传入网页助手. 这些标签不会替换飞书助手原有的系统指令.
- SSE 在网页结果评论到达后发送内容, 最后发送 `finish_reason: stop` 和 `[DONE]`. 不将完整回答切成假 token, 不保证逐 token 推送.
- 将 `stream_options.include_usage` 设为 `true` 时, 在上游提供统计的情况下返回 usage. 统计包含助手内部上下文和工具产生的 token.
- 查看响应头 `X-Aily-Task-Id`, 定位本次飞书任务.
- 查看响应头 `X-Aily-Ignored-Parameters`, 确认网页助手接管的采样和长度参数. `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, 惩罚项, `seed`, `reasoning_effort` 不会改变上游运行配置.

## 外部工具

使用客户端执行工具, 网关仅转发工具声明, 调用请求和执行结果. 不让网关直接执行模型生成的代码或命令.

1. 在请求中提交标准 `tools: [{"type":"function","function":{...}}]`.
2. 接收 `finish_reason: "tool_calls"` 及 `message.tool_calls`. 流式请求从 `delta.tool_calls` 读取调用.
3. 在客户端执行被调用的工具, 遵循客户端已有的工具授权设置.
4. 将原 assistant 工具调用消息加入历史, 再追加 `role: "tool"`, `tool_call_id` 和字符串 `content`.
5. 携带完整历史继续请求. 网关将执行结果送回同一飞书任务, 助手可以继续请求工具或给出最终答案.

- 使用 `tool_choice: "auto"`, `"required"`, `"none"`, 或 `{"type":"function","function":{"name":"工具名"}}` 控制本轮调用.
- 使用乐乐时, 在需要外部工具的轮次设置 `tool_choice: "required"`, 或直接指定函数名. 乐乐的 `auto` 选择不稳定, 可能直接回答而不产生调用.
- 按串行方式执行多步骤工具链. 每轮最多请求一个外部工具; `parallel_tool_calls: true` 不会强制生成多个调用.
- 每次请求最多声明 64 个工具, 声明总长度不超过 200000 字符. 重复工具名和无效定义会在调用飞书前被拒绝.
- 将每个工具结果的 ID 与历史中的调用一一对应. 重复结果, 未知 ID 和缺失结果会返回 400.
- 为参数声明 JSON Schema Draft 7 或 2020-12. 网关使用 Ajv 检查类型, 必填字段, 枚举, 数值范围, 附加字段等约束, 不自动转换类型或删除字段. `format` 作为注解处理, 不加载远程 `$ref`.
- 将参数不合法, 工具名未声明, 强制调用未满足和协议格式错误视为失败. 网关返回结构化错误, 不把这些结果转换为可执行调用.
- 含外部工具的回复会缓冲到上游本轮结束, 校验通过后才返回工具调用或文本. SSE 仍发送保活消息, 工具协议标记不会出现在客户端正文中.
- 查看响应头 `X-Aily-Tool-Mode: prompt-bridge`, 识别外部工具适配请求.

此功能通过提示协议实现. 飞书助手将工具调用请求作为任务结果提交, 网关解析为标准 OpenAI `tool_calls`; 客户端执行后, 网关通过新评论回传工具结果. 这不是飞书原生 Function Calling 或受约束的模型解码, 可靠性取决于助手遵守协议. 协议文本会出现在飞书任务记录中. 不把协议成功解析等同于对所有客户端或所有工具的成功验证.

当前兼容性实测: 原先的 `aily_buddy` 助手通过 JSON, SSE, `auto` 选择和两步串行外部工具链验证. `agent_4kgf4uygwpt75n5` 乐乐通过普通对话, `required` 二选一, 指定函数名, 两步串行调用, 真实随机工具结果, 同一飞书任务续接和最终答案验证; 它的 `auto` 选择未通过稳定性验证.

## 使用边界

- 这是登录会话驱动的非官方网页接口适配, 上游网页协议变化后可能需要更新.
- `aily-assistant` 指向指定的飞书助手, 不代表可任选底层模型. 当前网页模型配置为 Auto.
- 仅接入当前电脑上的客户端. 服务绑定 `127.0.0.1`, 未配置公网或局域网访问, 未安装开机自启.
- 保留网页助手原有的企业权限, 内置工具, 额度与数据处理行为. 请求文本会发送给飞书, 新建任务和评论会显示在飞书任务记录中.
- 不支持 Responses API, 图片, 音频, embeddings, JSON Schema 回复格式或 stop 序列. 不把这些请求静默转为文本.
- 不直接提供 MCP 传输端点. 使用能将 MCP 工具转换为 OpenAI `tools` 并执行调用的客户端.
- 客户端断开或请求超时会停止本地等待, 不保证停止已经开始的云端任务. 此时先在飞书确认任务状态再重试.
- 不删除生成的任务. 网关持久化的会话映射只包含历史哈希, 任务 ID 和游标, 不保存聊天明文.
- Windows 登录凭据及本地 API Key 使用 DPAPI CurrentUser 加密, 只可由当前 Windows 账号解密. Linux 将凭据保存到权限为 `0600` 的本地文件. 不分享浏览器配置目录和凭据文件.

## 验证

在源码目录使用 Node.js 22 或更高版本执行:

```powershell
node --test test\bridge.test.mjs test\tools.test.mjs test\portable.test.mjs
```

仅在需要真实端到端验证时执行 `test\live.mjs`. 此测试会创建一条飞书任务并发送两轮测试消息, 使用实际助手额度.

仅在需要外部工具端到端验证时执行 `test\live-tools.mjs`. 此测试使用 OpenAI JavaScript SDK 发起真实请求, 在测试客户端读取本机随机记录并计算签名, 验证 JSON 工具调用, SSE 工具调用, 两步串行工具链, 最终回答和同一任务续接. 测试会创建飞书任务并使用实际助手额度.

使用 `test\live-forced-tools.mjs` 验证乐乐的指定函数名模式和两步串行工具链. 测试同样会创建飞书任务并使用实际助手额度.
