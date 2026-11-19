# page-eye

给 AI 编程助手一双看页面的眼睛。

AI 读的是源码，读不到浏览器**真正画出来的东西**——背景色可能是 `var(--x)` 叠了三层，间距可能来自组件库默认值，阴影可能是 `shadow-sm` 展开的五个值，图标可能是 `::before` 里一个看不见的私用区字符。而网络返回、console 报错、点击之后发生了什么——源码里根本没有。

仓库里有两个互补的工具，都围绕同一件事：**别让人转述，让 AI 直连现场。**

![演示：问卡片样式 → 拿到真实值 → 改颜色 → 再问一次](assets/demo.gif)

> 这不是手写截图。右侧每一行都是 `element_style` 工具的真实返回；最后一步改掉卡片的 `--card-bg` 再问一次，返回的新值就是浏览器此刻画出来的颜色。

## 最快路径（3 步）

**1. 起一个带调试端口的 Chrome**

```powershell
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\cdp-profile"
```

> `--user-data-dir` 不是可选项。新版 Chrome 不允许在默认配置上开远程调试。
>
> macOS / Linux 把可执行文件换成 `google-chrome`（或 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），`--user-data-dir` 换成 `/tmp/cdp-profile`。

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

**只是想让 AI 知道样式、不想装 MCP？** 直接看 [trae-style-snapshot](trae-style-snapshot/README.zh-CN.md) —— 控制台贴一段脚本，零配置。

## 仓库结构

```
mcp-cdp/              MCP server：通过 CDP 把页面的内容 / 行为 / 网络交给 AI
trae-style-snapshot/  浏览器脚本：把渲染后的样式压成一段 AI 能读的 JSON
```

## 22 个工具，按你熟悉的 DevTools 面板组织

这套接口基本对应你在 DevTools 里手动做的事。

### Elements —— 查看和改动 DOM

| 工具 | 作用 |
| --- | --- |
| `page_overview` | 标题、URL、DOM 规模、主要区块、请求分组、日志计数、最近错误 |
| `element_style` | 给选择器，返回渲染后的背景/阴影/边框/圆角/间距/字体，**以及每个值来自哪个 CSS 变量** |
| `a11y_tree` | 无障碍树：页面「是什么」（heading / link / button），比 DOM 树省 token 且带语义 |
| `frames` | 所有 frame 加 iframe / worker 子 target——用来判断内容是不是在别的 frame 里 |
| `screenshot` | 把 PNG（元素 / 视口 / 整页）存到磁盘并返回路径，绝不把 base64 灌进上下文 |
| `highlight` | 在页面上高亮元素，让「你指的那块」和 AI 指的是同一块 |

### Styles —— 查看和改动 CSS

| 工具 | 作用 |
| --- | --- |
| `element_style` | 计算值 + 变量溯源（见上） |
| `css_coverage` | 重载后统计 CSS 规则使用率：总数、用到、没用、按样式表分组——找死代码 |
| `emulate_media` | 强制 `prefers-color-scheme`、`print`、`prefers-reduced-motion`，一次抓多态 |
| `resize` | 改视口（手机/平板/桌面），可选重载，并回一份体检：横向溢出、越界元素、小于 32px 的点按目标 |

### Console —— 看消息、跑 JavaScript

| 工具 | 作用 |
| --- | --- |
| `console_logs` | console 输出、未捕获异常、浏览器日志；可按级别和关键字过滤 |
| `run_js` | 在页面里执行 JavaScript 并取值。逃生舱 |

### Sources —— 调试 JavaScript

| 工具 | 作用 |
| --- | --- |
| `debugger_ctl` | 暂停于异常、按 URL + 行号下断点、等待暂停并读调用栈、恢复、关闭 |

### Network —— 检查网络活动

| 工具 | 作用 |
| --- | --- |
| `network_list` | 请求摘要（不含正文）：method、URL、状态码、大小、耗时、失败原因 |
| `network_get` | 单条请求全貌：头、POST 体、响应体（超 8000 字落盘） |
| `net_conditions` | 禁缓存、模拟延迟与带宽、断网——用来诚实量化首屏 |
| `net_mock` | 拦截并伪造响应：mock 接口、改响应、模拟错误状态码 |

### Performance —— 优化速度

| 工具 | 作用 |
| --- | --- |
| `perf_metrics` | 布局/样式重算次数与耗时、脚本耗时、JS 堆、节点数 |

### 会话控制

| 工具 | 作用 |
| --- | --- |
| `targets` | 列出可调试标签，标出当前连的是哪个 |
| `use_target` | 按 index / id / URL 片段切换标签 |
| `recorder` | `status` 看缓冲、`clear` 清空、`reload` 从头录 |
| `navigate` | 打开完整 URL 或站内路径（如 `/add`），等到 `readyState` 为 `complete` |
| `interact` | 滚动（可触发懒加载）、点击（选择器**或可见文字**）、填表（选择器或 placeholder）、按键——并回报变化：URL、节点、文本、请求、日志 |

## 和其他浏览器 MCP 的区别

| | **page-eye** | **chrome-devtools-mcp** | **chrome-inspector-mcp** |
| --- | --- | --- | --- |
| 维护方 | 本仓库 | Google / ChromeDevTools | 社区（devtoolcss） |
| 工具数 | 22 | 63（若干分类需额外 flag 才开） | 6 |
| 安装 | 克隆后 `node server.mjs` | `npx -y chrome-devtools-mcp@latest` | npx + 装一个 Chrome 扩展 |
| 依赖 | 无 | Puppeteer、npm、Node LTS | Chrome 扩展 |
| 遥测 | 无 | 默认上报使用统计；trace 可能发往 CrUX | 无 |
| 输入自动化 | 只有 `run_js` | 完整：click / fill / drag / hover / press_key / wait_for | — |
| CSS | 选择器 → 计算值 **+ 来自哪个 CSS 变量**，自动去重变体 | uid → 匹配规则（标 `[overloaded]`）、级联层、`var()` 解析值 | 匹配规则、computed style |
| 网络 | 列表 → 详情，大 body 落盘，条件模拟 + mock | 列表 → 详情，条件模拟 + mock | — |
| 性能 | 只有指标 | trace + insights + CrUX 实测数据 + Lighthouse | — |
| 内存 | — | 14 个堆快照工具 | — |
| 文档 | 中英双版 | 英文 | 英文 |

**一句话：`chrome-devtools-mcp` 更大、更官方、能力更全。除非下面三条正好是你的痛点，否则优先用它。**

这个仓库优化的是：

1. **什么都不用装**：一个文件、`node server.mjs`。没有 npm、没有 Puppeteer 下载、不会版本漂移，也没有需要记住的遥测开关。
2. **把「上下文预算」当设计目标，而不是事后补救**：变体去重带 `count`、尺寸差异用 `sizeRange` 而不是拆成两款、大 body 落盘、`pagePerf` 明确标注只作参考。难点从来不是「能不能读到」，而是「该让多少进对话」。
3. **「这个像素是哪个变量给的」**：`element_style` 一次就能答 `vars: { bg: ["--card"] }`。`get_css_styles` 答的是更深一层——**为什么**（哪条规则赢了、谁被覆盖了）。两个不同的问题，两种工具。

两者不互斥：调试端口同时接受多个 CDP 客户端（本仓库的并发测试就同时持有 5 条以上连接到同一页面），可以都指向同一个 Chrome。

## 为什么是这个形状

难点从来不是「能不能读到」，而是**什么该进上下文**。

一个真实页面 200+ 请求，一个列表接口 300KB JSON。全灌进对话，模型还没开始推理就先把上下文撑满了。所以整个 server 围绕三条规则：

1. **先索引，再下钻**：`network_list` 只回摘要加 `requestId`，看哪条由 AI 自己决定。
2. **大对象落盘**：响应体超过 8000 字写进 `.cdp-capture/`，只回预览和绝对路径。
3. **从已知起点开始录**：CDP 抓不到 attach 之前的请求，`recorder reload` 是让首屏采集完整的开关。

## 几个值得知道的设计决定

- **工具调用是串行的**：采集缓冲、连接、target 都是共享状态，并发改动不安全；交互式调试也不需要并行。一次发很多调用没问题，它们会排队。
- **`ensure()` 用单飞 Promise**：N 个并发调用只建一条 CDP WebSocket。少了这层，每个调用各建一条，被丢弃的连接仍会往共享缓冲写事件，同一行 console 被记 N 遍。
- **`recorder reload` 会阻塞其它调用**，直到页面稳定。这是有意的。

## 任意 MCP 客户端都能用

纯 stdio MCP server，除 Node 20+ 外没有运行时依赖。TRAE、Cursor、Claude Code 都可以直接驱动。

```powershell
node mcp-cdp/server.mjs          # 在 stdio 上说 JSON-RPC
```

## 验证

一条命令跑全部，**每个套件都用一台全新的 Chrome**，互不污染：

```powershell
node mcp-cdp/run-tests.mjs              # 全部 113 条
node mcp-cdp/run-tests.mjs service      # 只跑某个套件
```

| 套件 | 条数 | 覆盖 |
| --- | --- | --- |
| `transport` | 44 | MCP 握手、真实 200/404/500、POST 体、大 body 落盘、console 各级别、未捕获异常、多标签切换、`element_style` |
| `capabilities` | 37 | 十项扩展工具的正常路径 + 副作用检查 |
| `service` | 46 | 协议层（未知方法、坏 JSON、缺参数）、每个工具的错误路径、并发、进程生命周期 |
| `concurrency-5` / `-12` | 各 4 | 并行调用只建一条 CDP 连接，事件不重复 |

**135 / 135，连续三次全跑通过。**

`trae-style-snapshot` 有自己的一套：**51** 条断言、**12** 个边界输入不抛异常、4809 节点压力测试。

## 环境要求

- Node.js 20+（用全局 `WebSocket` 和 `fetch`）
- Chrome 用 `--remote-debugging-port` 启动，且 `--user-data-dir` 不能是默认配置

## 许可

[MIT](LICENSE) © 2026 王虎 (Raywh)

---

[English](README.md)
