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
{ "action": "break", "urlRegex": "main\\.js", "lineNumber": 41 }
{ "action": "wait", "timeoutMs": 8000 }
{ "action": "resume" }
{ "action": "off" }
```
`wait` blocks until the debugger pauses, returns up to 8 call frames (`fn`, `url`, `line`) and resumes unless you pass `"resume": false`.

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
{ "urlPattern": "/api/items", "status": 500, "body": "{\"error\":\"boom\"}" }
{ "clear": true }
```
Enables the Fetch domain and fulfils matching requests. Everything unmatched is continued untouched.

### Performance

#### `perf_metrics`
No parameters. Layout / style recalc counts and durations, script and task time, JS heap, node count.

## Pitfalls this server already handles

| Pitfall | Handling |
| --- | --- |
| Response bodies expire | Fetched eagerly on `loadingFinished` |
| `console.warn` is `warning` in CDP | Normalised to `warn` |
| `postData` is optional on `requestWillBeSent` | Falls back to `Network.getRequestPostData` |
| `data:` URLs contain the whole body | Truncated in output; body comes from the body field |
| `encodedDataLength` stays non-zero on cache hits | `fromCache` flag + `pagePerf` reported separately |
| Concurrent calls each opened a CDP socket | Single-flight `ensure()`; calls are also serialised |

## Limits

- Main frame only — cross-origin iframes and workers need `Target.setAutoAttach` (listed by `frames`, not readable yet)
- No WebSocket frames (`Network.webSocketFrameReceived` not wired up)
- Request and log buffers cap at 500 / 800 entries, oldest dropped
- Binary response bodies are marked, not stored
- `recorder reload` blocks other tool calls until the page settles
- `.cdp-capture/` grows over time; prune it yourself

## Verification

```
test-client.mjs           44/44 assertions
capabilities-test.mjs     22/22  (all ten extended capabilities)
concurrency-test.mjs      5-way and 12-way → 1 connection, exact event counts
```

```powershell
node serve.mjs                                   # fixture server on :8799
# then: Chrome --remote-debugging-port=9223 http://127.0.0.1:8799/
$env:CDP_ENDPOINT='http://127.0.0.1:9223'; node test-client.mjs
```

---

[中文文档](README.zh-CN.md)
