# mcp-cdp

An MCP server that lets an AI agent see a live page: DOM, styles, console, network, performance — over the Chrome DevTools Protocol.

Zero dependencies (Node built-ins + the global `WebSocket`/`fetch`). One process is both the MCP stdio server and the CDP client.

![Demo](../assets/demo.gif)

## Why it exists

CDP is the only place where DOM, network bodies and console all meet. But an agent cannot talk to a debugging port — it can only call MCP tools. And an existing inspector MCP covers DOM/CSS only, with no network and no console.

So the real design problem is not *how to read* — it is **what should enter the context**. This server answers that with three rules:

1. **Index, then drill.** `network_list` returns summaries plus a `request_id`. The agent decides what to fetch in full.
2. **Spill to disk.** Bodies over 8000 characters go to `.cdp-capture/`; only a preview and an absolute path come back.
3. **Record from a known point.** CDP cannot see requests made before you attached. `recorder reload` is the switch that makes first-load capture complete.

## Setup

```powershell
# Chrome must be started with a non-default profile
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\cdp-profile"
```

```json
{
  "mcpServers": {
    "page-eye": {
      "command": "node",
      "args": ["<absolute-path>/mcp-cdp/server.mjs"],
      "env": {
        "CDP_ENDPOINT": "http://127.0.0.1:9222",
        "CDP_CAPTURE_DIR": "<absolute-path>/mcp-cdp/.cdp-capture"
      }
    }
  }
}
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `CDP_ENDPOINT` | `http://127.0.0.1:9222` | Where to find Chrome |
| `CDP_URL_CONTAINS` | — | Pick a tab whose URL/title contains this |
| `CDP_CAPTURE_DIR` | `./.cdp-capture` | Where spills and screenshots land |

## Tools

### Session

#### `targets`
Lists debuggable tabs and marks the attached one. Call it whenever the agent seems to be reading the wrong page.

#### `use_target`
```json
{ "index": 0 }            // or { "id": "ABC..." } or { "urlContains": "localhost:3000" }
```
Pins the session to a tab. Switching clears the capture buffers.

#### `recorder`
```json
{ "action": "reload", "ignoreCache": true, "waitMs": 3000 }
```
| action | Effect |
| --- | --- |
| `status` | Current buffer sizes and endpoint |
| `clear` | Empty the buffers |
| `reload` | Reload the page and record from zero |

> CDP cannot see requests made before attach. If you need the complete first load, always `reload`.

#### `navigate`
```json
{ "url": "/add", "settleMs": 400 }
```
Accepts an in-site path or an absolute URL, waits for `readyState === 'complete'`, then waits `settleMs` more for the app to render. Returns the final URL and title. If Chrome refuses the URL it returns `{ error }` instead of throwing. It also remembers the last good origin, so you can recover with a relative path after landing on an error page.

#### `interact`
```json
{ "action": "scroll", "to": "bottom", "steps": 30, "waitMs": 500 }
{ "action": "click", "text": "Vue" }
{ "action": "fill", "placeholder": "搜索题目关键词", "value": "闭包" }
{ "action": "press", "key": "Enter" }
```
Targets can be a CSS `selector`, a visible `text` (exact match first, then prefix), or a `placeholder`. Fill uses the native value setter plus `input`/`change` events so Vue and React bindings pick it up.

Every call returns what changed, which is the point:

```json
{
  "ok": true,
  "action": "click",
  "clicked": "button",
  "label": "Vue",
  "changed": { "nodes": 0, "textLength": 125, "requests": 1, "logs": 0 }
}
```

`scroll` stops early once the page height stops growing, so it terminates on pages without lazy loading instead of looping for 30 steps.

### Elements

#### `page_overview`
No parameters. Returns title, URL, DOM size, landmark elements, request groups, log counts and the last few errors. The right first call.

#### `element_style`
```json
{
  "selector": "skill-block",                     // bare name also works: tries #x then .x
  "properties": ["background", "shadow"],        // optional filter
  "max": 6
}
```
Returns rendered styles for up to `max` **variants** (identical styles are merged, with a `count`):

```json
{
  "selector": ".skill-block",
  "matched": 3,
  "variants": 1,
  "nodes": [{
    "sel": "div.skill-block:nth-of-type(1)",
    "size": "421×166",
    "padding": "24px 26px",
    "bg": "rgb(255, 255, 255)",
    "radius": "20px",
    "border": "1px solid rgb(231, 227, 218)",
    "shadow": "rgba(27, 28, 32, 0.04) 0px 1px 2px 0px, rgba(27, 28, 32, 0.04) 0px 2px 8px 0px",
    "color": "rgb(27, 28, 32)",
    "font": "400 16px/28px -apple-system",
    "vars": { "bg": ["--card"], "shadow": ["--shadow-sm"], "radius": ["--radius-lg"] },
    "count": 3
  }]
}
```

`properties` accepts: `background` `shadow` `border` `radius` `spacing` `layout` `typography` `color` `effect` `vars`. `vars` is pruned to match the filter — ask for `background` and you get `vars.bg` only.

Variable provenance is computed by normalising every `--*` value through a hidden probe element, so `#2563eb`, `rgb(37,99,235)` and a differently ordered `box-shadow` all match. The probe is removed afterwards.

The snapshot script is injected **once per document** and kept under `window.__pe`; any page globals it would otherwise shadow (`snap`, `page`, `pick`, …) are restored immediately. A new document (navigation) triggers a fresh injection.

#### `a11y_tree`
```json
{ "roles": "heading,link,button", "limit": 40 }
```
The accessibility tree — 1300 AX nodes on a normal blog collapse to a couple hundred meaningful roles. Cheaper and more semantic than a DOM dump.

#### `frames`
No parameters. All frames plus iframe/worker sub-targets. If the thing you are looking for is "not there", it is usually in another frame.

#### `screenshot`
```json
{ "selector": "main" }   // or { "fullPage": true }, or neither for the viewport
```
Writes a PNG to `CDP_CAPTURE_DIR` and returns `{ path, bytes, clip }`. The base64 never enters the context.

#### `highlight`
```json
{ "selector": ".card", "color": "#00b3ff" }
```
Flashes the element via the Overlay domain. `{ "clear": true }` hides it.

### Styles

#### `css_coverage`
```json
{ "reload": true, "waitMs": 3000 }
```
Reloads with cache off, records rule usage, then reports:
```json
{ "rules": 166, "used": 166, "unused": 0, "unusedPct": 0, "sheets": [...] }
```
Chrome marks a rule "used" when it matched at least one element — so this is most meaningful across navigations (shared stylesheets, multiple pages).

#### `emulate_media`
```json
{ "scheme": "dark", "media": "print", "reducedMotion": "reduce" }
```
Forces media features and reports what the page now sees (`scheme`, `bodyBg`, `bodyColor`). `{ "reset": true }` restores defaults.

#### `resize`
```json
{ "width": 390, "height": 844, "mobile": true, "reload": true }
{ "reset": true }
```
Resizes the layout viewport and returns a check:

```json
{
  "viewport": "390x844",
  "windowWidth": 390,
  "scrollbarPx": 0,
  "horizontalOverflow": false,
  "overflowPx": 0,
  "offenders": [],
  "smallTapTargets": 1
}
```

Two details worth knowing:

- `viewport` comes from `clientWidth`, which excludes the scrollbar; `windowWidth` is `innerWidth`. On desktop the 15px difference is a scrollbar, not a bug — `scrollbarPx` reports it explicitly.
- With `mobile: true`, a page **without** `<meta name="viewport" content="width=device-width">` lays out at 980px and scales down. When that happens the response carries a `note` explaining it, instead of silently reporting a viewport you did not ask for.

### Console

#### `console_logs`
```json
{ "level": "error,exception", "contains": "boom", "limit": 40 }
```
Captures `console.*`, uncaught exceptions and browser log entries (CSP, resource failures).

> CDP reports `console.warn` as type `warning`. This server normalises it to `warn`, and accepts `warning` in filters too.

#### `run_js`
```json
{ "expression": "document.title", "awaitPromise": true, "maxLength": 6000 }
```
The escape hatch. Read the DOM, compute styles, click, call an API.

### Sources

#### `debugger_ctl`
```json
{ "action": "exceptions", "state": "uncaught" }
{ "action": "break", "urlRegex": "main\\.js", "lineNumber": 41, "condition": "user.id === 7" }
{ "action": "wait", "timeoutMs": 8000 }
{ "action": "resume" }
{ "action": "off" }
```
`wait` blocks until the debugger pauses, returns up to 8 call frames (`fn`, `url`, `line`) and resumes unless you pass `"resume": false`.

`break` supports `condition`; breakpoints are tracked and removed explicitly, because `Debugger.disable` does not reliably clear them and re-adding the same location fails with `Breakpoint at specified location already exists`.

### Network

#### `network_list`
```json
{ "url": "/api/", "method": "POST", "status": 500, "failedOnly": true, "limit": 30 }
```
Summaries only, each with a `requestId`, a `body` marker (`inline` / `file:<path>` / `pending`) and a `size`.

#### `network_get`
```json
{ "requestId": "1234.56", "waitBody": true, "maxBody": 4000 }
```
Headers, POST body, response body. Bodies over 8000 characters come back as `bodyFile` + `bodyPreview`.

> Response bodies are only available while the request is still alive in the renderer. The server fetches them immediately on `loadingFinished`; querying later returns `No resource with given identifier`.

#### `net_conditions`
```json
{ "cacheDisabled": true, "latencyMs": 150, "downloadKbps": 400, "uploadKbps": 400 }
{ "reset": true }
```
Conditions persist until reset. Pair with `recorder reload` to measure a real first load.

#### `net_mock`
```json
{ "urlPattern": "/api/items", "mode": "fulfill", "status": 500, "body": "{\"error\":\"boom\"}" }
{ "urlPattern": "/api/analytics", "mode": "abort", "errorReason": "Aborted" }
{ "urlPattern": "/api/old", "mode": "rewrite", "url": "/api/items" }
{ "clear": true }
```

| mode | Effect |
| --- | --- |
| `fulfill` (default) | Answer with `status` / `body` / `headers` |
| `abort` | Fail the request with `errorReason` |
| `rewrite` | Let it through, but change `url` / `method` / `headers` / `postData` first |

`rewrite` accepts a site-relative `url`; it is resolved to an absolute URL because `Fetch.continueRequest` only takes absolute ones.

### Performance

#### `perf_metrics`
No parameters. Layout / style recalc counts and durations, script and task time, JS heap, node count.

## Compared to other browser MCP servers

`chrome-devtools-mcp` — official, 63 tools, Puppeteer input automation, performance traces, 14 heap-snapshot tools — is the bigger and more capable option. Use it when you need browser automation or performance analysis.

This server's niche: **zero dependencies, context discipline, and CSS-variable provenance**. Full comparison table in the [root README](../README.md).

## Cancellation

Long-running tools (`navigate`, `interact` with `scroll`) check a cancel flag between steps, so a client-side timeout can actually free the queue:

```json
{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}
```

The call returns an error mentioning 取消 and the serialized queue moves on. A single in-flight CDP command cannot be interrupted — only the polling loops around it.

## Pitfalls this server already handles

| Pitfall | Handling |
| --- | --- |
| Response bodies expire | Fetched eagerly on `loadingFinished` |
| `console.warn` is `warning` in CDP | Normalised to `warn` |
| `postData` is optional on `requestWillBeSent` | Falls back to `Network.getRequestPostData` |
| `data:` URLs contain the whole body | Truncated in output; body comes from the body field |
| `encodedDataLength` stays non-zero on cache hits | `fromCache` flag + `pagePerf` reported separately |
| Concurrent calls each opened a CDP socket | Single-flight `ensure()`; calls are also serialised |

## Performance

Measured on the fixture page (Chrome 157, headless):

| What | Result |
| --- | --- |
| Cold start (spawn → first ping) | 39 ms |
| First tool call (includes CDP connect) | 36 ms |
| Tool latency, warm | p50 0–3 ms, p95 ≤ 8 ms (`highlight` 18 ms on first use) |
| 10 parallel `run_js` vs 10 sequential | 8 ms vs 15 ms |
| Overhead vs raw CDP `Runtime.evaluate` | ~1 ms (p50) |
| 2000 extra DOM nodes | `page_overview` 55 ms, `element_style` 14 ms, `a11y_tree` 138 ms |
| 400 navigations | RSS 47 → 88 MB, step-wise GC sawtooth, no linear growth (buffers capped at 500 / 800 / 400) |

Run it yourself: `node perf-test.mjs` (needs `serve.mjs` + Chrome on `CDP_ENDPOINT`).

## Limits

- Main frame only — cross-origin iframes and workers need `Target.setAutoAttach` (listed by `frames`, not readable yet)
- No WebSocket frames (`Network.webSocketFrameReceived` not wired up)
- Request and log buffers cap at 500 / 800 entries, oldest dropped
- Binary response bodies are marked, not stored
- `recorder reload` blocks other tool calls until the page settles
- `.cdp-capture/` grows over time; prune it yourself

## Verification

```powershell
node run-tests.mjs              # every suite, 113 checks
node run-tests.mjs service      # a single suite
```

The runner starts the fixture server and a **fresh Chrome per suite**, so suites cannot leak state into each other (extra tabs, mocks, media emulation, buffers).

| Suite | Checks | Covers |
| --- | --- | --- |
| `transport` (`test-client.mjs`) | 44 | handshake, 200/404/500, POST body, body spill, console levels, tab switching, `element_style` |
| `capabilities` (`capabilities-test.mjs`) | 42 | the ten extended tools, happy path + side effects |
| `service` (`suite-service.mjs`) | 46 | protocol errors, every tool's error path, lifecycle |
| `concurrency` (`concurrency-test.mjs`) | 4 × 2 | one CDP connection, no duplicate events |

**140 / 140 across all suites.**

Writing `suite-service.mjs` immediately found two real bugs that the earlier suites had hidden:

1. **`highlight` only worked if `css_coverage` ran first.** `DOM.enable` was never called, so it failed with `DOM should be enabled first`. The older suite happened to call `css_coverage` earlier, which masked it.
2. **`run_js` stringified every result.** `matchMedia(...).matches` came back as `"false"` and an HTTP status as `"418"`. It now returns native JSON types and only falls back to a truncated string when the value is too large.

---

[中文文档](README.zh-CN.md)
