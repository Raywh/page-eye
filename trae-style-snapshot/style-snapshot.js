/**
 * style-snapshot.js —— 把浏览器里「渲染后的样式」压成 AI 能直接读的 JSON
 *
 * 解决的问题：AI 只看得到源码，看不到 getComputedStyle 之后的结果。
 * 背景色可能是 var() 叠出来的、间距可能来自组件库默认值、阴影可能是
 * Tailwind 的 shadow-sm 展开、图标可能是 ::before + iconfont 或 mask-image。
 *
 * 用法（在页面控制台里贴一次，或在 TRAE 的内置浏览器里执行）：
 *   page()                    // 页面级背景 / 字体 / 容器
 *   snap('.card')             // 单个元素（总是带图标）
 *   snapAll('.btn')           // 一组元素，自动按「样式签名」去重成变体
 *   pick()                    // 点谁抓谁；pick.cancel() 撤销
 *   tokens()                  // 当前页面所有 CSS 变量的原始表
 *
 * 拿到结果后 copy(JSON.stringify(...)) 粘进 TRAE 即可。
 */
(function () {
  'use strict';

  var MAX_ICON = 300;          // 单个图标源码最多抄多少字符
  var MAX_ICON_NODES = 60;     // 单个元素最多往下探几个后代找图标
  var ICON_CAP = 6;            // 一个元素最多报几个不同图标
  var DEFAULT_SCAN_LIMIT = 300; // snapAll 默认最多真正解析几个元素
  var DEFAULT_MAX_VARIANTS = 24;
  var PUA = /[\uE000-\uF8FF]/; // iconfont 字形落在这个私用区

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  function qsa(sel) {
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    catch (e) { return null; } // 非法选择器
  }

  function esc(sel) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(sel);
    return String(sel).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  // ---------------------------------------------------------------- 探针
  // 用来把任意 CSS 值规范成「计算值」，这样 token 里的 #2563eb
  // 能和元素上的 rgb(37, 99, 235) 对上；shadow 的书写顺序也能抹平。
  // 用完立刻删掉，不在 DOM 里留痕迹。
  function makeProbe() {
    var p = document.createElement('div');
    p.setAttribute('aria-hidden', 'true');
    p.setAttribute('data-style-snapshot', 'probe');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    (document.body || document.documentElement).appendChild(p);
    return p;
  }

  // 顺序有讲究：颜色类在最前，box-shadow 放最后
  // —— 它接受两个长度，`--pad: 10px 16px` 这种会被它抢走
  var RULES = [
    ['color', 'color'],
    ['background-color', 'color'],
    ['border-color', 'color'],
    ['border-radius', 'length'],
    ['font-size', 'length'],
    ['letter-spacing', 'length'],
    ['row-gap', 'length'],
    ['padding-top', 'length'],
    ['box-shadow', 'shadow']
  ];

  function normalizeValue(p, raw) {
    for (var i = 0; i < RULES.length; i++) {
      var prop = RULES[i][0], family = RULES[i][1];
      p.style.removeProperty(prop);
      p.style.setProperty(prop, raw);
      // 值非法时浏览器会直接丢弃声明，这是可靠的合法性判据
      if (!p.style.getPropertyValue(prop)) continue;
      var v = getComputedStyle(p).getPropertyValue(prop).trim();
      p.style.removeProperty(prop);
      if (!v || v === 'none' || v === 'auto') continue;
      return { family: family, value: v };
    }
    return null;
  }

  // ---------------------------------------------------------------- token 表
  // 长度类 token 会互相撞值（--space-2 和 --radius-md 都可能是 8px），
  // 所以长度类必须再用命名过滤一遍，宁可漏报也不误报。
  var PREFER = {
    bg: /(color|background|bg|surface|brand|primary|fill)/i,
    color: /(color|text|fg|ink|foreground)/i,
    radius: /(radius|rounded)/i,
    shadow: /(shadow|elevation)/i,
    gap: /(space|gap|spacing|gutter)/i,
    font: /(font|size|text|type)/i
  };

  var tokenCache = null;

  // 主题切换通常是改 html 上的 class / data-theme，变了就重扫
  function cacheKey() {
    var r = document.documentElement;
    return (r.className || '') + '|' + r.getAttribute('data-theme') + '|' + r.getAttribute('style');
  }

  function collectTokens(force) {
    var key = cacheKey();
    if (tokenCache && !force && tokenCache.key === key) return tokenCache;

    var root = document.documentElement;
    var cs = getComputedStyle(root);
    var names = [];

    // 现代 Chrome 会把自定义属性也列进 computed style 的枚举
    for (var i = 0; i < cs.length; i++) {
      var n = cs.item(i);
      if (n && n.indexOf('--') === 0) names.push(n);
    }

    // 兜底：扫同源样式表
    if (!names.length) {
      var seenName = {};
      var walk = function (rules) {
        for (var j = 0; j < rules.length; j++) {
          var r = rules[j];
          if (r.style) {
            for (var k = 0; k < r.style.length; k++) {
              var pn = r.style.item(k);
              if (pn && pn.indexOf('--') === 0 && !seenName[pn]) { seenName[pn] = 1; names.push(pn); }
            }
          }
          if (r.cssRules) walk(r.cssRules);
        }
      };
      for (var s = 0; s < document.styleSheets.length; s++) {
        try { walk(document.styleSheets[s].cssRules); } catch (e) { /* 跨域样式表读不到，跳过 */ }
      }
    }

    var byKey = new Map();
    var raw = {};
    var probe = makeProbe();
    try {
      names.slice(0, 500).forEach(function (name) {
        var v = clean(cs.getPropertyValue(name));
        if (!v) return;
        raw[name] = v;
        // 全透明色不参与匹配，否则任何透明背景都会命中它，纯误报
        if (/^transparent$/i.test(v) || /^rgba?\([^)]*,\s*0\s*\)$/i.test(v)) return;
        var norm = normalizeValue(probe, v);
        if (!norm) return;
        var key2 = norm.family + '|' + norm.value;
        if (!byKey.has(key2)) byKey.set(key2, []);
        byKey.get(key2).push(name);
      });
    } finally {
      if (probe.parentNode) probe.parentNode.removeChild(probe);
    }

    tokenCache = { key: key, byKey: byKey, raw: raw };
    return tokenCache;
  }

  function matchToken(tokens, bucket, family, value) {
    if (!value) return null;
    var names = tokens.byKey.get(family + '|' + value);
    if (!names || !names.length) return null;
    if (family === 'length') {
      var re = PREFER[bucket];
      if (!re) return null;
      names = names.filter(function (x) { return re.test(x); });
      if (!names.length) return null;
    }
    return names.slice(0, 2);
  }

  // ---------------------------------------------------------------- 选择器
  var NOISE = /^(css-|sc-|jsx-|_)/;

  function stableClasses(el, n) {
    if (typeof el.className !== 'string') return [];
    return el.className.split(/\s+/).filter(function (c) { return c && !NOISE.test(c); }).slice(0, n);
  }

  function simpleSel(el, nClasses) {
    // 父级有 id 就直接用 id，比一路 nth-child 短得多，也更好读
    if (el.id) return '#' + esc(el.id);
    return el.tagName.toLowerCase() + stableClasses(el, nClasses).map(function (c) {
      return '.' + esc(c);
    }).join('');
  }

  // 必须真的能唯一定位到 el 才返回，否则返回 null
  // —— 宁可不给，也不给一个会误导 AI 的串
  function unique(sel, el) {
    var found = qsa(sel);
    return !!(found && found.length === 1 && found[0] === el);
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return null;

    if (el.id) {
      var byId = '#' + esc(el.id);
      if (unique(byId, el)) return byId;
    }

    var base = simpleSel(el, 3);
    if (unique(base, el)) return base;

    // 同款元素有多个时，用 nth-of-type 收到这一个（比整条 nth-child 路径短得多）
    var nthIdx = 1, sib0 = el;
    while ((sib0 = sib0.previousElementSibling)) if (sib0.tagName === el.tagName) nthIdx++;
    var nth = base + ':nth-of-type(' + nthIdx + ')';
    if (unique(nth, el)) return nth;

    // 往上加一层父级上下文，最多 3 层
    var leafNth = base + ':nth-of-type(' + nthIdx + ')';
    var cur = base;
    var node = el.parentElement;
    var depth = 0;
    while (node && depth < 3 && node !== document.documentElement) {
      var p2 = simpleSel(node, 2);
      cur = p2 + ' > ' + cur;
      if (unique(cur, el)) return cur;
      // 同款元素（比如 .btn 和 .btn--ghost 都带 .btn）靠 nth-of-type 分辨
      var alt = p2 + ' > ' + leafNth;
      if (unique(alt, el)) return alt;
      node = node.parentElement;
      depth++;
    }

    // 最后用 nth-child 路径
    var path = [];
    var walker = el;
    while (walker && walker !== document.documentElement && path.length < 5) {
      var idx = 1, sib = walker;
      while ((sib = sib.previousElementSibling)) idx++;
      path.unshift(walker.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      walker = walker.parentElement;
    }
    if (path.length) {
      var full = path.join(' > ');
      if (unique(full, el)) return full;
    }

    // 元素已脱离文档、或在 Shadow DOM 里 —— 定位不到就老实说
    return null;
  }

  // ---------------------------------------------------------------- 图标
  function describe(el) {
    var t = el.tagName.toLowerCase();
    var c = stableClasses(el, 2);
    return c.length ? t + '.' + c.join('.') : t;
  }

  // 只看元素自己的文本节点，不含子孙
  function ownPuaText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return PUA.test(t) ? t.trim() : null;
  }

  // 私用区字符在 JSON 里是不可见的，转成 \e600 这种能在源码里 grep 的形式
  function escGlyph(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c < 0x20 || (c >= 0xE000 && c <= 0xF8FF)) ? '\\' + c.toString(16) : s[i];
    }
    return out;
  }

  function pseudoIcons(el, where) {
    var found = [];
    ['::before', '::after'].forEach(function (pe) {
      var pcs;
      try { pcs = getComputedStyle(el, pe); } catch (e) { return; }
      var c = pcs.content;
      if (!c || c === 'none' || c === 'normal') return;
      if (PUA.test(c)) {
        found.push({
          kind: 'iconfont', via: pe, where: where,
          glyph: escGlyph(c.replace(/^"|"$/g, '')), family: pcs.fontFamily, size: pcs.fontSize
        });
      } else if (c !== '""' && c !== "''") {
        found.push({ kind: 'pseudo-text', via: pe, where: where, content: cut(c, 60), family: pcs.fontFamily });
      }
    });
    return found;
  }

  function iconOf(el, cs) {
    // 页面根节点不报图标，否则整页图标全糊上来，纯噪声
    if (el === document.body || el === document.documentElement) return null;

    var out = [];
    var seen = {};

    function push(x) {
      if (!x || out.length >= ICON_CAP) return;
      var k = x.kind + '|' + (x.glyph || x.src || x.html || x.value || '');
      if (seen[k]) return; // 五个一模一样的装饰 svg 不该占满名额
      seen[k] = 1;
      out.push(x);
    }

    function boxOf(node) {
      var r = node.getBoundingClientRect();
      return Math.round(r.width) + '×' + Math.round(r.height);
    }

    function maskOf(node, where) {
      var m = node.getPropertyValue('mask-image') || node.getPropertyValue('-webkit-mask-image');
      if (m && m !== 'none' && m.trim()) push({ kind: 'mask-image', where: where, value: cut(m, 200) });
    }

    function bgImgOf(node, where) {
      if (/url\(/i.test(node.backgroundImage)) {
        push({ kind: 'bg-image', where: where, value: cut(node.backgroundImage, 200) });
      }
    }

    // ---- 元素自身就是图标
    var tag = el.tagName.toLowerCase();
    if (tag === 'svg') push({ kind: 'svg', where: 'self', size: boxOf(el), html: cut(el.outerHTML, MAX_ICON) });
    if (tag === 'img') push({ kind: 'img', where: 'self', size: boxOf(el), src: cut(el.currentSrc || el.src, 200) });

    var own = ownPuaText(el);
    if (own) {
      push({ kind: 'iconfont', via: 'text', where: 'self', glyph: escGlyph(own), family: cs.fontFamily, size: cs.fontSize });
    }
    pseudoIcons(el, 'self').forEach(push);
    bgImgOf(cs, 'self');
    maskOf(cs, 'self');

    // ---- 子孙里的图标：图标常常藏在 <i>/<span> 里
    var kids = el.querySelectorAll('*');
    for (var i = 0; i < kids.length && i < MAX_ICON_NODES && out.length < ICON_CAP; i++) {
      var k = kids[i];
      var kt = k.tagName.toLowerCase();
      var where = describe(k);

      if (kt === 'svg') {
        var parentIsSvg = k.parentElement && k.parentElement.tagName.toLowerCase() === 'svg';
        if (!parentIsSvg) push({ kind: 'svg', where: where, size: boxOf(k), html: cut(k.outerHTML, MAX_ICON) });
        continue;
      }
      if (kt === 'img') {
        push({ kind: 'img', where: where, size: boxOf(k), src: cut(k.currentSrc || k.src, 200) });
        continue;
      }

      var t = ownPuaText(k);
      if (t) {
        var tcs = getComputedStyle(k);
        push({ kind: 'iconfont', via: 'text', where: where, glyph: escGlyph(t), family: tcs.fontFamily, size: tcs.fontSize });
      } else {
        pseudoIcons(k, where).forEach(push);
        var kcs = getComputedStyle(k);
        bgImgOf(kcs, where);
        maskOf(kcs, where);
      }
    }

    return out.length ? out : null;
  }

  // ---------------------------------------------------------------- 单元素
  // 注意：这里不生成 sel —— selectorOf 要查全文档，只该给最终输出的元素算
  function snapOne(el, tokens, withIcons) {
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return { error: '元素不可读' }; }

    var r = el.getBoundingClientRect();
    var o = { tag: el.tagName.toLowerCase() };

    var cls = clean(typeof el.className === 'string' ? el.className : '');
    if (cls) o.class = cut(cls, 80);

    // 容器太大时不算文本：整棵子树 textContent 是隐形开销
    if (el.childElementCount <= 12) {
      var text = cut(clean(el.textContent), 30);
      if (text) o.text = text;
    }

    o.size = Math.round(r.width) + '×' + Math.round(r.height);

    if (cs.display !== 'block') o.display = cs.display;
    if (/flex|grid/.test(cs.display)) {
      if (cs.flexDirection !== 'row') o.flexDirection = cs.flexDirection;
      if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') o.gap = cs.gap;
      if (cs.alignItems !== 'normal') o.alignItems = cs.alignItems;
      if (cs.justifyContent !== 'normal') o.justifyContent = cs.justifyContent;
    }

    // 间距
    if (cs.padding !== '0px') o.padding = cs.padding;
    if (cs.margin !== '0px') o.margin = cs.margin;

    // 视觉
    o.bg = cs.backgroundColor;
    if (cs.backgroundImage !== 'none') o.bgImage = cut(cs.backgroundImage, 160);
    var backdrop = cs.getPropertyValue('backdrop-filter');
    if (backdrop && backdrop !== 'none') o.backdropFilter = backdrop;
    if (cs.borderRadius !== '0px') o.radius = cs.borderRadius;

    // 四边都看，不能只看 top —— 只有下边框的 tab 会被漏掉
    var SIDES = [['Top', 'top'], ['Right', 'right'], ['Bottom', 'bottom'], ['Left', 'left']];
    var sideVals = SIDES.map(function (s) {
      return cs['border' + s[0] + 'Width'] + ' ' + cs['border' + s[0] + 'Style'] + ' ' + cs['border' + s[0] + 'Color'];
    });
    var drawn = sideVals.filter(function (v) { return v.indexOf('0px') !== 0; });
    if (drawn.length === 4 && drawn.every(function (v) { return v === drawn[0]; })) {
      o.border = drawn[0];
    } else if (drawn.length) {
      var b = {};
      SIDES.forEach(function (s, i) { if (sideVals[i].indexOf('0px') !== 0) b[s[1]] = sideVals[i]; });
      o.border = b;
    }

    if (cs.boxShadow !== 'none') o.shadow = cs.boxShadow;
    if (cs.opacity !== '1') o.opacity = cs.opacity;
    if (cs.filter !== 'none') o.filter = cs.filter;

    // 字
    o.color = cs.color;
    o.font = cs.fontWeight + ' ' + cs.fontSize + '/' + cs.lineHeight + ' ' +
             clean(cs.fontFamily.split(',')[0]);
    if (cs.letterSpacing !== 'normal') o.letterSpacing = cs.letterSpacing;
    if (cs.textAlign !== 'start' && cs.textAlign !== 'left') o.textAlign = cs.textAlign;

    // token 溯源
    var vars = {};
    function put(bucket, family, value) {
      var hit = matchToken(tokens, bucket, family, value);
      if (hit) vars[bucket] = hit;
    }
    put('bg', 'color', cs.backgroundColor);
    put('color', 'color', cs.color);
    put('shadow', 'shadow', cs.boxShadow);
    // 四角不一致时，单看 topLeft 会对上不相干的 token
    if (!/\s/.test(cs.borderRadius)) put('radius', 'length', cs.borderRadius);
    put('gap', 'length', cs.rowGap);
    put('font', 'length', cs.fontSize);
    if (Object.keys(vars).length) o.vars = vars;

    if (withIcons !== false) {
      var icon = iconOf(el, cs);
      if (icon) o.icon = icon;
    }

    return o;
  }

  // ---------------------------------------------------------------- 对外 API
  function toEls(sel) {
    if (sel && sel.nodeType === 1) return [sel];
    if (typeof sel !== 'string' || !sel.trim()) return [];
    return qsa(sel); // null 表示选择器非法
  }

  // 参与去重的属性：漏一个，两种款式就会被并成一个
  var SIG_KEYS = [
    'display', 'flexDirection', 'alignItems', 'justifyContent', 'gap',
    'padding', 'margin', 'bg', 'bgImage', 'backdropFilter', 'radius', 'border',
    'shadow', 'opacity', 'filter', 'font', 'letterSpacing', 'textAlign', 'color'
  ];

  function signatureOf(o) {
    var parts = SIG_KEYS.map(function (k) { return o[k]; });
    parts.push(o.icon ? o.icon.map(function (i) { return i.kind + (i.size || ''); }).join() : '');
    return JSON.stringify(parts);
  }

  function snapAll(sel, opts) {
    opts = opts || {};
    var max = opts.max == null ? DEFAULT_MAX_VARIANTS : opts.max;
    var limit = opts.limit == null ? DEFAULT_SCAN_LIMIT : opts.limit;

    var els = toEls(sel);
    if (els === null) return { error: '选择器无效：' + sel };
    if (!els.length) return { error: '没有匹配到元素：' + sel };

    // 真正解析的元素数量设上限：snapAll('*') 在万级页面是要卡死的
    var scanned = els.slice(0, Math.max(1, limit));
    var truncatedScan = els.length > scanned.length;

    // 解析量已被 limit 限住（默认 300），图标扫描的开销也随之有界
    var withIcons = opts.icons !== false;

    var tokens = collectTokens();
    var groups = new Map();

    scanned.forEach(function (el) {
      var o = snapOne(el, tokens, withIcons);
      if (!o || o.error) return;
      var sig = signatureOf(o);
      if (!groups.has(sig)) groups.set(sig, { node: o, el: el, count: 0, texts: [], sizes: [] });
      var g = groups.get(sig);
      g.count++;
      var wh = o.size.split('×').map(Number);
      g.sizes.push(wh);
      if (o.text && g.texts.length < 3 && g.texts.indexOf(o.text) === -1) g.texts.push(o.text);
    });

    var nodes = [];
    var truncatedVariants = false;
    groups.forEach(function (g) {
      if (nodes.length >= max) { truncatedVariants = true; return; }
      var n = {};
      var s = selectorOf(g.el);
      if (s) n.sel = s;
      for (var k in g.node) if (g.node.hasOwnProperty(k)) n[k] = g.node[k];
      delete n.text;

      if (g.count > 1) n.count = g.count;
      if (g.texts.length) n.text = g.texts;

      // 同款但尺寸差异大（width:100% vs 固定宽）：不拆变体，标出区间
      var minW = Math.min.apply(null, g.sizes.map(function (x) { return x[0]; }));
      var maxW = Math.max.apply(null, g.sizes.map(function (x) { return x[0]; }));
      var minH = Math.min.apply(null, g.sizes.map(function (x) { return x[1]; }));
      var maxH = Math.max.apply(null, g.sizes.map(function (x) { return x[1]; }));
      if (maxW - minW > 2 || maxH - minH > 2) {
        n.sizeRange = minW + '×' + minH + ' – ' + maxW + '×' + maxH;
      }
      nodes.push(n);
    });

    var res = {
      total: els.length,
      scanned: scanned.length,
      variants: nodes.length,
      nodes: nodes
    };
    if (truncatedScan) res.scanTruncated = '只解析了前 ' + scanned.length + ' 个元素（共 ' + els.length + '），可用 {limit:N} 提高';
    if (truncatedVariants) res.variantsTruncated = '变体数超过 ' + max + '，只列出前 ' + max + ' 个';
    return res;
  }

  function snap(sel) {
    // 只要一个元素，就不该受 snapAll 的批量启发式影响
    var els = toEls(sel);
    if (els === null) return { error: '选择器无效：' + sel };
    if (!els.length) return { error: '没有匹配到元素：' + sel };

    var o = snapOne(els[0], collectTokens(), true);
    if (o.error) return o;

    var out = {};
    var s = selectorOf(els[0]);
    if (s) out.sel = s;
    for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
    return out;
  }

  function page() {
    var els = [document.documentElement, document.body];
    var wrap = document.querySelector('#app, #root, [data-app], main');
    if (wrap && els.indexOf(wrap) === -1) els.push(wrap);
    var tokens = collectTokens();
    return els.filter(Boolean).map(function (el) {
      var o = snapOne(el, tokens, false);
      var s = selectorOf(el);
      if (!s) return o;
      var out = { sel: s };
      for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
      return out;
    });
  }

  function tokens() {
    return collectTokens(true).raw;
  }

  var pickHandler = null;
  var pickResolve = null;

  function pick() {
    return new Promise(function (resolve) {
      pick.cancel();
      pickResolve = resolve;

      var prevCursor = document.body ? document.body.style.cursor : '';
      if (document.body) document.body.style.cursor = 'crosshair';

      pickHandler = function (e) {
        e.preventDefault();
        e.stopImmediatePropagation(); // 阻止同一次点击把上一轮 pick 也触发掉
        var target = e.target;
        pick.cancel();
        if (document.body) document.body.style.cursor = prevCursor;
        var out = snap(target);
        console.log(JSON.stringify(out, null, 2));
        if (pickResolve) { var r = pickResolve; pickResolve = null; r(out); }
      };
      window.addEventListener('click', pickHandler, true);
    });
  }

  pick.cancel = function () {
    if (pickHandler) window.removeEventListener('click', pickHandler, true);
    pickHandler = null;
    if (pickResolve) { var r = pickResolve; pickResolve = null; r(null); }
    if (document.body) document.body.style.cursor = '';
  };

  window.snap = snap;
  window.snapAll = snapAll;
  window.page = page;
  window.tokens = tokens;
  window.pick = pick;

  console.log('[style-snapshot] 就绪：snap(sel) / snapAll(sel) / page() / pick() / tokens()');
})();
