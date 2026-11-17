# mcp-cdp

让 TRAE 通过 MCP 看到页面的**内容、行为、网络返回**。零依赖（只用 Node 内置模块 + 全局 WebSocket），一个进程同时是 MCP server 和 CDP 客户端。

## 为什么不是"用 CDP"或"用现成 MCP"，而是这个形状

CDP 是唯一的数据源——Chrome 里没有第二个口子能同时拿到 DOM、网络体、console。

但**直接用 CDP 不行**：Trae 没法连一个调试端口，它只会调 MCP 工具。每个工具调用都得是一次"有意义的检索"，而不是一次协议往返。

现成的 `chrome-inspector-mcp` 只有 DOM/CSS，**没有网络、没有 console**——正好缺掉你要的两块。

所以真正要设计的不是"用哪个协议"，是：

> **什么该进上下文，什么只该留一个入口。**

一个真实页面 200+ 请求，一个列表接口 300KB JSON。全量灌进对话，AI 还没开始分析，上下文就满了。这个 server 的全部设计都是在解决这件事。

## 六个工具

| 工具 | 作用 | 返回什么 |
| --- | --- | --- |
| `page_overview` | 建立全局印象 | 标题/URL/DOM 规模/主要区块 + 请求分组统计 + 日志计数 + 最近错误 |
| `network_list` | 找请求 | 摘要：method/url/status/size/耗时/失败原因，**不含 body** |
| `network_get` | 看单条 | 完整头 + POST 体 + 响应体（超 8000 字落盘，只回预览+路径） |
| `console_logs` | 看输出 | console / 未捕获异常 / 浏览器日志，按级别和关键字过滤 |
| `run_js` | 逃生舱 | 在页面里执行 JS 返回值。读 DOM、算样式、点按钮全靠它 |
| `recorder` | 控制采集 | `clear` 清缓冲 / `reload` 从头录 / `status` 看现状 |

### 三个关键设计

**① 索引与下钻，不 dump**
`network_list` 只回摘要，`requestId` 是下钻的把手。AI 先看分组，再决定看哪几条——而不是一上来收到 200 条完整请求。

**② 大对象落盘**
响应体超过 8000 字就写进 `.cdp-capture/`，工具只回 `bodyFile` + 1500 字预览。AI 需要细节时自己去读那个文件。**上下文和磁盘各司其职**。

**③ attach 即开始录，reload 补全**
CDP 抓不到 attach 之前的请求。所以 `recorder reload` 是"从零开始录"的开关——重新加载页面，把首屏请求全部收进来。

## 接进 TRAE

先起一个带调试端口的 Chrome（**用独立的 user-data-dir**，新版 Chrome 对默认配置开远程调试有限制）：

```powershell
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\cdp-profile"
```

然后在项目里 `.trae/mcp.json`（需先在 设置 → MCP 打开「项目级 MCP」）：

```json
{
  "mcpServers": {
    "page-eye": {
      "command": "node",
      "args": ["path/to/page-eye/mcp-cdp/server.mjs"],
      "env": {
        "CDP_ENDPOINT": "http://127.0.0.1:9222",
        "CDP_URL_CONTAINS": "localhost:3000"
      }
    }
  }
}
```

`CDP_URL_CONTAINS` 用来在多标签时挑目标（不填就取第一个 page）。

然后对 Trae 说：

> 用 page-eye 的 recorder reload 重新加载页面，然后 page_overview 看整体，把失败请求和 error 日志列出来。

## 一定会踩的四个坑（都实测过）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| **响应体有时效** | 请求结束后过一会儿再取 → `No resource with given identifier` | 在 `loadingFinished` 立刻取，别拖到用户提问时 |
| **`console.warn` 不是 `warn`** | 按 `warn` 过滤永远为空 | CDP 里 type 是 `warning`，server 已统一成 `warn` |
| **`postData` 是可选字段** | POST 的请求体读不到 | `requestWillBeSent` 里没有时，补一次 `Network.getRequestPostData` |
| **`data:` / `blob:` 的 URL 就是 body** | 拿一条记录等于把正文灌两遍 | URL 超长时截断，正文只从 `body` 字段给 |

另外：**attach 之前发生的请求永远抓不到**。想抓全量就 `recorder reload`。

## 关于"行为"

AI 不可能"看"到行为，只能通过三种方式间接得到：

1. **回放** —— `run_js` 点按钮、填表单，然后看新产生的日志和请求
2. **观察** —— console、网络、导航事件构成了行为的可观测面
3. **插桩** —— 注入代码包装 `fetch`/`XMLHttpRequest`、监听 DOM 变化

这个 server 目前做的是 1 和 2。想把"行为"做得更准，下一步是 3：在 `run_js` 里注入一个统一的埋点脚本，把用户操作、状态变化、请求串成同一条时间线。

**别指望 AI"理解"行为，要把它变成可查询的时序记录。**

## 已知边界

- 只抓主 frame，**iframe 里的请求要单独 attach**
- **不抓 WebSocket 帧**（`Network.webSocketFrameReceived` 没接）
- 请求缓冲上限 500 条、日志 800 条，超了丢最旧的
- 二进制响应体不落盘（只标记 `binary`）
- console 的深对象只序列化一层预览，要完整值用 `run_js`
- 大 body 落盘目录会持续增长，需要自己清

## 验证

零依赖手写 MCP stdio，用最小客户端跑完整握手：

```
31 条断言 × 连跑 3 次 = 全过
```

覆盖：`initialize` 握手、`tools/list`、真实 HTTP 的 200/404/500、POST 请求体、20000 字响应体落盘、console 四个级别、未捕获异常、对象参数序列化、`run_js` 触发点击后再读到新日志、JS 语法错不崩。

跑法：

```powershell
node serve.mjs                                     # 起本地夹具服务 :8799
# 另开窗口：Chrome 带 --remote-debugging-port=9222 打开 http://127.0.0.1:8799/
node test-client.mjs                               # 结果写 test-result.json
```
