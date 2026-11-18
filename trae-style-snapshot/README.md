# trae-style-snapshot

Let an AI see a page's **rendered** styles, not the styles it guesses from source.

AI reads source code. But the background may be a `var(--x)` resolved three layers deep, spacing may come from a library default, a shadow may be a `shadow-sm` expanded into five parts, and an icon may be one invisible private-use character inside a `::before`. **What you wrote and what gets painted are two different things.**

This script walks `getComputedStyle` once and compresses the result into JSON your AI can read.

## Quick start

Paste `style-snapshot.js` into the page console once, then:

```js
snap('.card')                              // one element, always with icons
snapAll('.btn')                            // a group, deduplicated into variants
page()                                     // page-level background / font
pick()                                     // click to pick; pick.cancel() to abort
copy(JSON.stringify(snapAll('.card')))     // paste into your AI
```

## What the output looks like

Real output (headless Chrome 157, viewport 1200×800, page: `fixture.html`):

```json
{
  "sel": "#card-a > button.btn:nth-of-type(1)",
  "tag": "button",
  "class": "btn",
  "size": "84×40",
  "display": "inline-flex",
  "gap": "8px",
  "alignItems": "center",
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
  "icon": [{ "kind": "svg", "where": "svg", "size": "16×16", "html": "<svg …>" }],
  "count": 2,
  "text": ["新建"]
}
```

Four things that matter:

- **`vars`** — which CSS variable this `rgb(37, 99, 235)` came from. Every `--*` value is normalised through a hidden probe element, so `#2563eb`, `rgb(37,99,235)` and differently ordered shadows all match. The probe is deleted right after use.
- **`sel`** — only emitted when it genuinely resolves to that element; otherwise the field is omitted rather than pointing somewhere wrong.
- **`icon`** — not just "there is an icon", but which implementation, where, and how to grep it in source.
- **`count`** — `2` means this is the second identical button, so the AI does not think you have two button designs.

## Icons deserve their own section

There are at least six implementations, and `className="icon-search"` tells you nothing about which one you got:

| Kind | `kind` | What you get |
| --- | --- | --- |
| Inline SVG | `svg` | `where` + size + the **full SVG source** (up to 300 chars) |
| Image | `img` | `where` + size + `src` (including data URIs) |
| Icon font (pseudo-element) | `iconfont` | `via: "::before"` + `glyph: "\e600"` + font family + `where: "i.iconfont.icon-close"` |
| Icon font (element text) | `iconfont` | `via: "text"` + escaped code point |
| CSS mask | `mask-image` | the mask URL |
| Background image | `bg-image` | only `url(...)` — **gradients are not icons** |

- Code points are escaped to `\e600` because private-use characters are invisible in JSON, while your source says `content: "\e600"` — this way the AI can grep for it.
- Icons inside child nodes are found too (the classic `<i class="iconfont icon-close">`).
- Identical icons are deduplicated so five decorative SVGs cannot crowd out the one you care about.

## API

| API | Purpose |
| --- | --- |
| `snap(sel)` | First match, always with icons |
| `snapAll(sel, {max, limit, icons})` | Dedupe into variants |
| `page()` | `html` / `body` / container background and font |
| `pick()` | Click-to-pick; `pick.cancel()` aborts |
| `tokens()` | Raw table of every CSS variable in the page |

Two limits on `snapAll`:

- `max` (default 24) — variants returned; sets `variantsTruncated` when hit.
- `limit` (default 300) — elements actually parsed; keeps `snapAll('*')` from freezing on a huge page. Sets `scanTruncated` when hit.

The **style signature** decides whether two elements are the same variant. It covers display, flex direction, alignment, gap, padding, margin, background, gradient, radius, border, shadow, opacity, filter, font, letter spacing, colour and icon kinds — **but not size or text**, so three buttons with different label lengths are not three designs. Size differences are reported as `sizeRange` instead of splitting the variant.

## Performance

4809 DOM nodes, 600 `.item` elements (warmed up, excluding first layout):

| Call | Time | Elements parsed |
| --- | --- | --- |
| `snapAll('.item')` | 18 ms | 300 (`limit`) |
| `snapAll('.item', {icons:false})` | 7 ms | 300 |
| `snapAll('.item', {limit:600})` | 27 ms | 600 |
| `snapAll('*')` | 12 ms | 300 |
| `snap('.item')` | 0.3 ms | 1 |

## Using it with TRAE

1. **Design source** (new pages) — put your tokens in CSS variables and the conventions in TRAE Rules.
2. **Snapshot** (existing pages) — this script. Paste once, `copy(...)`, paste into chat.
3. **Live connection** (repeated UI work) — use the [mcp-cdp](../mcp-cdp/README.md) MCP server instead, so the agent can query by itself.
4. **Visual check** — TRAE's built-in browser plus auto screenshot. Layout yes, exact numbers no.

## Known limits

- **Cross-origin stylesheets are unreadable** — variables are only collected from same-origin CSS.
- **Variables are collected from `:root` only** — anything defined on `.dark` or component scope is missed.
- **Length-like tokens are matched by name** — `--space-2` and `--radius-md` can both be `8px`, so length tokens must look like `radius` / `space` / `gap` / `font`. Missing a token is preferred over reporting a wrong one.
- **Shadow DOM is not traversed** — elements inside a shadow root get no `sel`.
- **Detached elements get no `sel`** — they cannot resolve themselves and have no real size.
- **Up to 6 icons, first 60 descendants** — truncated on very large subtrees.
- **Gradients are never treated as icons.**
- **A bad selector never throws** — `snap('')` and `snapAll('>>>')` return `{error}`.
- **Token table caps at 500 entries.**
- **`page()` takes the first match** for its container guess.

## Verification

CDP drives headless Chrome; assertions live in the page:

- **51 assertions pass.** `fixture.html` hard-codes ground truth; `verify-run.js` checks the script against it.
- **12 edge inputs, none throw**: empty selector, invalid selector, `document`, detached element, an `<svg>` element itself, two consecutive `pick()` calls.
- **`probe-github.html`** — a dark page in this repo that I did not write: `body` background `rgb(13, 17, 23)`, nav `padding: 18px 32px`, `letter-spacing: -0.184px`, SVG logo source all correct.

### What two review rounds found

Round one was self-testing: **29/33**, four failures exposed three real bugs — pseudo-element icons inside child nodes were missed, `<img>` elements were not in their own descendants, gradients were reported as icons.

Round two was an independent read-only review with 15 findings. Every real one was fixed **with an assertion attached**, so a future regression shows up as a failing check rather than a silent wrong answer. Two examples: the variant signature ignored `opacity` / `filter` / alignment (two designs collapsed into one), and `sel` did not escape Tailwind classes such as `w-[10px]`.

Reproduce:

```powershell
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
Start-Process $chrome -ArgumentList @('--headless=new','--remote-debugging-port=9333',
  "--user-data-dir=$env:TEMP\cs-cdp",'about:blank')
node cdp-harness.mjs "file:///<repo>/trae-style-snapshot/verify.html"   # 51 assertions
node cdp-harness.mjs "file:///<repo>/trae-style-snapshot/probe-edge.html"
```

---

[中文文档](README.zh-CN.md)
