# page-eye

给 AI 一双看页面的眼睛。

AI 编码助手（TRAE / Cursor / Claude Code…）只能读源码，读不到**渲染之后**的东西：背景色可能是 `var(--x)` 叠出来的，间距可能来自组件库默认值，阴影可能是 `shadow-sm` 展开的五层值，图标可能是伪元素里一个看不见的字符。而网络返回、console 报错、点击之后发生了什么——源码里根本没有。

这个仓库有两个互补的东西，都围绕同一件事：**别让人转述，让 AI 直连现场。**

![演示：AI 问卡片样式 → 工具返回真实值 → 改颜色后再问，值立刻更新](assets/demo.gif)

> 上面这段不是手写截图。右侧每一行都是 MCP 工具 `element_style` 的真实返回；最后一步改掉卡片的 `--card-bg` 再问一次，返回的新值就是浏览器此刻画出来的颜色。

## 最快路径（3 步）

**1. 起一个带调试端口的 Chrome**

```powershell
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\cdp-profile"
```

> `--user-data-dir` 不是可选项。新版 Chrome 不允许在默认配置上开远程调试，少了它端口根本起不来。
>
> macOS / Linux 把可执行文件换成 `google-chrome`（或 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），`--user-data-dir` 换成 `/tmp/cdp-profile` 即可。

**2. 项目里建 `.trae/mcp.json`**

```json
{
  "mcpServers": {
    "page-eye": {
      "command": "node",
      "args": ["<克隆路径>/mcp-cdp/server.mjs"],
      "env": { "CDP_ENDPOINT": "http://127.0.0.1:9222" }
    }
  }
}
```

> - 路径必须**绝对**。
> - Trae 要先在 `设置 → MCP` 打开「项目级 MCP」开关。
> - 若 AI 报 `spawn node ENOENT`，把 `command` 换成 node 的绝对路径（`where node` / `which node`）。

**3. 对 AI 说一句**

> 用 page-eye 的 `element_style` 看一下 `.card` 的背景和阴影。

---

Cursor / Claude Code 用同一份 JSON，只是文件位置不同（`.cursor/mcp.json`、`claude mcp add`）。

**只是想让 AI 知道样式、不想装 MCP？** 直接看 [trae-style-snapshot](trae-style-snapshot/README.md) —— 浏览器控制台贴一段脚本，零配置。

## 仓库结构

```
mcp-cdp/              MCP server：通过 CDP 把页面的内容 / 行为 / 网络交给 AI
trae-style-snapshot/  浏览器脚本：把渲染后的样式压成一段 AI 能读的 JSON
```

## mcp-cdp —— 给 AI 一个能查的页面

零依赖（只用 Node 内置模块 + 全局 `WebSocket`），一个进程同时是 MCP server 和 CDP 客户端。

**9 个工具**

| 工具 | 作用 |
| --- | --- |
| `targets` | 列出可调试的标签页，标出当前连的是哪个 |
| `use_target` | 按 index / id / url 切到另一个标签 |
| `page_overview` | 页面骨架 + 请求分组 + 日志计数 + 最近错误 |
| `element_style` | 给个选择器，返回背景/阴影/边框/间距/字体，**以及每个值来自哪个 CSS 变量** |
| `network_list` | 请求摘要（不含正文），可按 url / method / status / 失败过滤 |
| `network_get` | 单条请求的完整头 + POST 体 + 响应体（超 8000 字落盘） |
| `console_logs` | console / 未捕获异常 / 浏览器日志，可按级别过滤 |
| `run_js` | 在页面里执行 JS 的逃生舱 |
| `recorder` | `reload` 从头录 / `clear` / `status` |

三个关键设计都是为了**不把上下文撑爆**：索引与下钻分离、大对象落盘、attach 后靠 `reload` 补全早期请求。

快速开始见 [mcp-cdp/README.md](mcp-cdp/README.md)。

## trae-style-snapshot —— 一次性拿到整套视觉事实

不装任何东西，浏览器控制台里贴一次：

```js
snapAll('.card')        // 一组元素，按样式去重成变体
copy(JSON.stringify(...))  // 粘给 AI
```

它会给出背景、间距、圆角、阴影、字体，以及**图标是哪种实现**（内联 SVG / `img` / iconfont 伪元素 / mask / 背景图），字形会转义成 `\e600` 这种能直接在源码里 grep 的形式。

51 条断言验证，见 [trae-style-snapshot/README.md](trae-style-snapshot/README.md)。

## 两者怎么选

| 场景 | 用什么 |
| --- | --- |
| 新建页面、要 AI 遵守设计规范 | 把 design token 写成 CSS 变量，配进 Rules |
| 改现有页面、想知道"它到底长什么样" | `trae-style-snapshot` —— 贴一次，零基础设施 |
| 反复调 UI、追接口、看运行时行为 | `mcp-cdp` —— 让 AI 自己查 |

底层其实是同一套东西：`mcp-cdp` 走 CDP，`trae-style-snapshot` 直接调页面里的 `getComputedStyle`。前者能追到"为什么"，后者便宜到不需要配置。

## 环境要求

- Node.js 20+（用了全局 `WebSocket` 和 `fetch`）
- Chrome（用 `--remote-debugging-port` 启动，**必须配独立的 `--user-data-dir`**，新版 Chrome 不允许在默认配置上开远程调试）

## 验证状态

不是"应该能跑"，是跑过的：

- `mcp-cdp`：**44 条断言 × 连跑 2 次全过**，覆盖 MCP 握手、真实 HTTP 的 200/404/500、POST 请求体、大响应体落盘、console 四级、未捕获异常、多标签切换、`element_style` 的选择器解析与属性过滤
- `trae-style-snapshot`：**51 条断言全过** + 12 个边界输入不抛异常 + 4809 节点的性能实测

## 许可

[MIT](LICENSE) © 2026 王虎 (Raywh)
