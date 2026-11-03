# 思考强度控件

## 使用

主聊与侧聊的模型选择左侧提供“思考：默认”。
后端明确声明可用强度时生成对应选项；支持预算时显示自定义预算，
填写正整数 token 并按 Enter 保存。默认不覆盖服务端策略，关闭仅在明确支持
`none` 时提供。预算必须小于已配置的最大输出 token。

主聊选择保存到 Agent 的 `reasoningSelection`；侧聊选择只保存在本分支的
浏览器配置中，不修改 Agent。旧侧聊默认继承挂载时 Agent 配置。
模型切换不会擅自转换已保存的强度；不可用的值会标记，用户可改回默认。
后端拒绝不兼容的显式设置，不静默降低思考强度。

## 前后端契约

客户端通过 preload `getModelCapabilities(model)` 查询 VCP 后端
`GET /v1/model-capabilities?model=...`，只消费版本化的规范能力，不猜测供应商。

配置使用：
- `{version:1,mode:"default"}`
- `{version:1,mode:"effort",value:"high"}`
- `{version:1,mode:"budget",value:4096}`

IPC 将 `reasoningSelection` 移入 `vcpchatExtensions.reasoning`，
合并而非覆盖既有时间戳扩展。群聊两种发言入口也使用同一扩展格式。
客户端不会生成 reasoning_effort / thinking 等供应商字段。

单聊、侧聊、重新生成、手动续写、心流续写与群聊均传递偏好。
工具续轮和模型容灾由后端处理；发送中修改选择不改变已准备请求的快照。

## 激活与未知能力

需要重启后端与 VCPChat 加载主进程/preload/API 改动；单纯刷新页面不够。
旧后端或能力查询失败时只提供默认，不伪造支持状态。
没有能力声明的兼容上游，按后端 `docs/MODEL_REASONING.md` 配置精确覆盖。
本实现未自动写入任何上游能力覆盖，也未自动重启运行中的聊天。

## 验证边界

离线测试覆盖 DOM 位置、能力响应竞态、保存、分支存储、配置快照、既有
单聊/群聊/心流/侧聊回归。JSDOM 不等于 Electron 实机外观验收；
实际网关档位、供应商预算范围、重启后的运行效果需单独确认。