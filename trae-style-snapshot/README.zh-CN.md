# style-snapshot.js

让 TRAE（或任何 AI）看到页面**渲染之后**的样式，而不是它从源码里猜出来的样式。

AI 只读源码。但背景色可能是 `var(--x)` 叠出来的，间距可能来自组件库默认值，阴影可能是 `shadow-sm` 展开成的 5 个值，图标可能是 `::before` 里的一个私用区字符。**你写的和它渲染出来的，是两回事。**

这个脚本在页面里跑一遍 `getComputedStyle`，把结果压成 AI 能直接读的 JSON。

## 快速开始

在页面控制台（或 TRAE 的内置浏览器）里贴一次 `style-snapshot.js`，然后：

```js
snap('.card')                              // 单个元素，总是带图标
snapAll('.btn')                            // 一组元素，自动按样式去重成变体
page()                                     // 页面级背景 / 字体
pick()                                     // 点谁抓谁（pick.cancel() 撤销）
copy(JSON.stringify(snapAll('.card')))     // 拿走粘给 AI
```

把 JSON 粘给 AI，它就知道这个按钮到底用了什么底色、多少间距、几层阴影、图标是什么做的。

## 输出长什么样

下面是**真实输出**（headless Chrome 157，视口 1200×800，页面见 `fixture.html`）：

```json
{
  "sel": "#card-a > button.btn:nth-of-type(1)",
  "tag": "button",
  "class": "btn",
  "size": "84×40",
  "display": "inline-flex",
  "gap": "8px",
  "alignItems": "center",
  "justifyContent": "center",
  "padding": "10px 16px",
  "bg": "rgb(37, 99, 235)",
  "radius": "8px",
  "shadow": "rgba(0, 0, 0, 0.06) 0px 1px 2px 0px",
  "color": "rgb(255, 255, 255)",
  "font": "500 14px/20px Inter",
  "letterSpacing": "0.2px",
  "vars": {
    "bg": ["--brand"],
    "shadow": ["--shadow-sm"],
    "radius": ["--radius-md"],
    "gap": ["--space-2"]
  },
  "icon": [
    {
      "kind": "svg",
      "where": "svg",
      "size": "16×16",
      "html": "<svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\">…</svg>"
    }
  ],
  "count": 2,
  "text": ["新建"]
}
```

四个关键设计：

- **`vars`** —— 这个 `rgb(37, 99, 235)` 到底来自哪个 CSS 变量。
  做法是把每个 `--*` 变量丢进一个隐藏探针，用浏览器自己把它规范化成计算值再比对，所以 `#2563eb`、`rgb(37,99,235)`、`rgba(37, 99, 235, 1)` 能对上，`shadow` 的书写顺序差异也被抹平。**探针用完立刻从 DOM 删除**，不留痕迹。
- **`sel`** —— 只在真的能唯一定位到那个元素时才给，否则整个字段不出现（而不是给一个看起来对、实际指向别处的串）。
- **`icon`** —— 不只是「有图标」，而是「什么形态、在哪、能不能在源码里搜到」。
- **`count`** —— 2 表示这是第 2 个长得一模一样的按钮。AI 不会以为你有两套按钮样式。

## 图标为什么单列

因为图标有至少 6 种实现，光看 JSX 经常看不出来 `className="icon-search"` 最后渲染成什么：

| 形态 | `kind` | 输出里带什么 |
| --- | --- | --- |
| 内联 SVG | `svg` | `where` + 尺寸 + **完整 SVG 源码**（不超过 300 字符） |
| 图片 | `img` | `where` + 尺寸 + `src`（含 data URI） |
| 图标字体（伪元素） | `iconfont` | `via: "::before"` + `glyph: "\e600"` + 字体族 + `where: "i.iconfont.icon-close"` |
| 图标字体（元素自身文本） | `iconfont` | `via: "text"` + 转义后的码位 |
| CSS mask | `mask-image` | mask 的 url |
| 背景图 | `bg-image` | 只报 `url(...)`，**渐变不算图标** |

- 字形码位转义成 `\e600`，因为私用区字符在 JSON 里**不可见**，而你源码里写的正是 `content: "\e600"`——这样 AI 才能 grep 到。
- 图标藏在子节点上也能抓到（`<i class="iconfont icon-close">` 这种最典型的写法）。
- 同一形态重复出现会去重，不会让 5 个一样的装饰 svg 占满名额。

## 五个 API

| API | 作用 |
| --- | --- |
| `snap(sel)` | 第一个匹配元素的样式对象，**总是带图标** |
| `snapAll(sel, {max, limit, icons})` | 按「样式签名」分组去重 |
| `page()` | `html` / `body` / 可能的容器根节点的背景与字体 |
| `pick()` | 进入选择模式，点页面上的元素；`pick.cancel()` 撤销 |
| `tokens()` | 当前页面所有 CSS 变量的原始表（`{ "--brand": "#2563eb", ... }`） |

`snapAll` 的两个上限：

- `max`（默认 24）—— 最多输出几个变体；超了会带 `variantsTruncated` 标记。
- `limit`（默认 300）—— 最多真正解析几个元素；`snapAll('*')` 在万级页面不会卡死。超了会带 `scanTruncated` 标记，`count` 也只统计被扫的那部分。

**样式签名**决定两个元素算不算同一款。它包含 display / flex 方向 / 对齐 / gap / padding / margin / 背景 / 渐变 / 圆角 / 边框 / 阴影 / opacity / filter / 字体 / 字距 / 颜色 / 图标形态，**但不含尺寸和文案**——否则三个字数不同的按钮会被当成三种款式。同款但尺寸差异大时，不拆变体，改为报 `sizeRange`。

## 性能

4809 个 DOM 节点、600 个 `.item`（已预热，不含首帧布局）：

| 调用 | 耗时 | 实际解析 |
| --- | --- | --- |
| `snapAll('.item')` | 18 ms | 300（由 `limit` 截断） |
| `snapAll('.item', {icons:false})` | 7 ms | 300 |
| `snapAll('.item', {limit:600})` | 27 ms | 600 |
| `snapAll('*')` | 12 ms | 300 |
| `snap('.item')` | 0.3 ms | 1 |

多次运行波动约 ±2ms。

## 接到 TRAE 上的四种方式

按成本从低到高，看你处在哪个场景：

1. **设计源头**（新建页面时）—— 把 design token 写成 CSS 变量文件，再把规范写进 TRAE 的 Rules，AI 每次对话自动带上。
2. **样式快照**（改现有页面时）—— 就是本脚本。贴一次，`copy(...)` 粘进对话框。
3. **直连浏览器**（反复调 UI 时）—— TRAE 支持 MCP。`chrome-inspector-mcp` 提供的 `getComputedStyle` / `getMatchedStyles` / `getNodes` 就是这件事的自动化版本，能让 AI 自己按 selector 去查，不用你手动导。
   注意它除了 MCP server 还要单独装一个 Chrome 扩展（从它的 Releases 页装），扩展负责在浏览器里干活，MCP server 只是转发。
   在项目根目录 `.trae/mcp.json` 里配置（要先在 设置 → MCP 里打开「项目级 MCP」开关）：

   ```json
   {
     "mcpServers": {
       "chrome-inspector": {
         "command": "npx",
         "args": ["-y", "chrome-inspector-mcp@latest"]
       }
     }
   }
   ```

4. **视觉对照**（判断"像不像"时）—— TRAE 的内置浏览器 + 自动截图。截了能看出版式，但拿不到数值，还是得靠上面三种补。

## 已知边界

以下都是真的限制，不是「还没测」：

- **跨域样式表读不到** —— 只扫同源 CSS 里的变量。
- **变量只从 `:root` 收** —— 定义在 `.dark` / 组件作用域上的变量收集不到，那些元素不会有 `vars`。改 `html` 的 class / `data-theme` 会自动重扫，但更深的主题作用域不行。
- **长度类 token 靠命名过滤** —— `--space-2` 和 `--radius-md` 都可能是 `8px`，值本身分不开。所以长度类只认命名像的（`radius`/`space`/`gap`/`font` 等），**宁可漏报也不误报**。你的 token 命名很野的话会漏。
- **不管 Shadow DOM** —— `querySelectorAll` 进不去 shadow root，里面的元素拿不到 `sel`。
- **已脱离文档的元素不给 `sel`** —— 它 `querySelectorAll` 定位不到自己，也拿不到真实尺寸。
- **图标最多报 6 个，只扫前 60 个后代节点** —— 元素内部特别大时会截断。
- **渐变不会被当成图标**。
- **控制台里敲错选择器不会炸** —— `snap('')`、`snapAll('>>>')` 都返回 `{error}` 而不是抛异常。
- **token 表最多收 500 个** —— 超出的会被静默丢掉（页面真有 500+ 个 CSS 变量时要注意）。
- **`page()` 的容器推断按文档顺序取第一个匹配** —— 页内小组件叫 `main` 之类的话可能被误当成页面容器。
- **探针解析 `currentColor` 时用的是探针自己的继承色** —— 不带颜色的阴影 token 可能溯源不准。

## 验证记录

不是「应该能跑」，是跑过。CDP 驱动 headless Chrome，断言写在页面里：

- **51 条断言全过**。夹具 `fixture.html` 里写死了真值，`verify-run.js` 逐条比对。
- **12 个边界输入全不抛异常**：空选择器、非法选择器、`document`、已脱离文档的元素、`<svg>` 元素本身、连续两次 `pick()` 等。
- **`probe-github.html`** 拿本仓库里一个**不是我写的**深色页面跑：`body` 背景 `rgb(13, 17, 23)`、导航 `padding: 18px 32px`、`letter-spacing: -0.184px`、SVG logo 源码全对。

### 两轮审查各自逼出了什么

第一轮是自测：**29/33**，4 条失败暴露 3 个真 bug——子节点上的伪元素图标抓不到、`<img>` 元素自己不在自己的子孙里、渐变被误报成图标。

第二轮是独立 subagent 只读审查，报了 15 条。真问题都修了，并且**每条都补了对应断言**，避免"修完看不出有没有修对"：

| 审查发现 | 修法 | 对应断言 |
| --- | --- | --- |
| 变体签名漏了 opacity/filter/对齐等，两种款式被并成一个 | 签名扩到 19 个属性，另加 `sizeRange` | `variant 变体数（只差 opacity）` |
| 边框只读 top，只有下边框的 tab 被合并 | 四边都读，混用时按边报对象 | `tab 变体数（只有下边框）`、`tab 报出了下边框` |
| 探针 div 永不删除，污染 DOM 且改变后续结果 | `try/finally` 里 `removeChild` | `探针不残留` |
| `sel` 不转义、不查重，Tailwind 类名直接抛错 | `CSS.escape` + 真的验证能唯一定位，否则不给 | `Tailwind 类名（含 : 和 []）能转义成合法选择器`、`已脱离文档的元素不给 sel` |
| `snapAll('*')` 对每个元素都做全文档查询 | 默认最多解析 300 个（`limit`），`sel` 改成只算给最终输出的元素 | `limit 生效`、压力测试 |
| 子节点上的 mask / 背景图图标漏报 | 遍历后代时一起查 | `card 图标四种形态` |
| 透明背景命中任意透明色 token | 全透明值不参与匹配 | `ghost 透明背景不溯源` |
| `max:0` 被 `\|\|` 吃成 24 | 改成 `== null` 判断 | `max:0 生效` |
| `pick()` 无取消、监听器泄漏、连点双触发 | `pick.cancel()` + `stopImmediatePropagation` | 边界探针 3 条 |
| 测试自己把 `documentElement` 清空导致 `body` 为 null | 只往 body 追加，不再清空 | 整个套件能跑完即是证明 |

`probe-stress.html` 用 4809 个 DOM 节点测耗时，数字见上面「性能」。

复现：

```powershell
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
Start-Process $chrome -ArgumentList @('--headless=new','--remote-debugging-port=9333',
  "--user-data-dir=$env:TEMP\cs-cdp",'about:blank')
node cdp-harness.mjs "file:///D:/deep-harness/trae-style-snapshot/verify.html"   # 51 条断言
node cdp-harness.mjs "file:///D:/deep-harness/trae-style-snapshot/probe-edge.html"
```

---

[English](README.md)
