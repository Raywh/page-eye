// 自校验：把 fixture.html 里写死的「真值」和 style-snapshot.js 的输出逐条对比
// 每条断言都独立 try/catch，一条炸了不影响其它条
window.addEventListener('load', function () {
  var checks = [];

  function record(name, expected, actual, pass) {
    checks.push({ name: name, expected: expected, actual: actual, pass: !!pass });
  }
  function eq(name, actual, expected) {
    record(name, expected, actual, actual === expected);
  }
  function has(name, arr, needle) {
    var ok = Array.isArray(arr) && arr.indexOf(needle) !== -1;
    record(name, 'contains ' + needle, arr, ok);
  }

  function run() {
    // 自定义属性能不能被 getComputedStyle 枚出来（决定走枚举还是兜底）
    var cs = getComputedStyle(document.documentElement);
    var enumerated = 0;
    for (var i = 0; i < cs.length; i++) if (cs.item(i).indexOf('--') === 0) enumerated++;

    var body = snap('body');
    var btns = snapAll('.btn');
    var card = snap('.card');
    var badge = snapAll('.badge');
    var hero = snap('.hero');
    var mask = snap('.mask-icon');
    var pageArr = page();
    var tokenTable = tokens();

    // ---- 背景色 / token 溯源
    eq('body.bg', body.bg, 'rgb(248, 250, 252)');
    eq('btn.bg', btns.nodes[0].bg, 'rgb(37, 99, 235)');
    has('btn.vars.bg', btns.nodes[0].vars && btns.nodes[0].vars.bg, '--brand');

    // 审查发现 7：透明背景不该命中任何颜色 token
    var ghostVars = btns.nodes[1].vars || {};
    record('ghost 透明背景不溯源', 'no vars.bg', ghostVars.bg, !ghostVars.bg);
    record('ghost 背景确为透明', 'rgba(0, 0, 0, 0)', btns.nodes[1].bg, btns.nodes[1].bg === 'rgba(0, 0, 0, 0)');

    // ---- 间距
    eq('btn.padding', btns.nodes[0].padding, '10px 16px');
    eq('btn.gap', btns.nodes[0].gap, '8px');
    has('btn.vars.gap', btns.nodes[0].vars && btns.nodes[0].vars.gap, '--space-2');
    eq('card.padding', card.padding, '24px');
    eq('card.margin', card.margin, '0px 0px 16px');

    // ---- 阴影
    eq('btn.shadow', btns.nodes[0].shadow, 'rgba(0, 0, 0, 0.06) 0px 1px 2px 0px');
    has('btn.vars.shadow', btns.nodes[0].vars && btns.nodes[0].vars.shadow, '--shadow-sm');
    eq('card.shadow', card.shadow, 'rgba(15, 23, 42, 0.1) 0px 4px 12px 0px');
    has('card.vars.shadow', card.vars && card.vars.shadow, '--shadow-md');

    // ---- 圆角 / 边框
    eq('card.radius', card.radius, '12px');
    has('card.vars.radius', card.vars && card.vars.radius, '--radius-lg');
    eq('btn.radius', btns.nodes[0].radius, '8px');
    has('btn.vars.radius', btns.nodes[0].vars && btns.nodes[0].vars.radius, '--radius-md');
    eq('card.border', card.border, '1px solid rgba(15, 23, 42, 0.06)');

    // ---- 字体
    eq('btn.font', btns.nodes[0].font, '500 14px/20px Inter');
    eq('btn.letterSpacing', btns.nodes[0].letterSpacing, '0.2px');

    // ---- 渐变背景
    var heroIsGradient = !!(hero && hero.bgImage && hero.bgImage.indexOf('gradient') !== -1);
    record('hero.bgImage 是渐变', true, hero && hero.bgImage, heroIsGradient);

    // ---- 变体去重
    eq('btn 元素总数', btns.total, 3);
    eq('btn 变体数', btns.variants, 2);
    eq('btn 主变体出现次数', btns.nodes[0].count, 2);
    eq('badge 变体数', badge.variants, 1);
    eq('badge count', badge.nodes[0].count, 2);

    // 审查发现 1：只差 opacity 的两个元素必须拆成两个变体
    var variants = snapAll('.variant');
    eq('variant 变体数（只差 opacity）', variants.variants, 2);
    var hasHalf = (variants.nodes || []).some(function (n) { return n.opacity === '0.5'; });
    record('variant 报出了 opacity', '0.5', variants.nodes.map(function (n) { return n.opacity; }), hasHalf);

    // 审查发现 2：只有下边框的 tab 必须拆成两个变体，且要报出下边框
    var tabs = snapAll('.tab');
    eq('tab 变体数（只有下边框）', tabs.variants, 2);
    var hasBottom = (tabs.nodes || []).some(function (n) { return n.border && n.border.bottom; });
    record('tab 报出了下边框', 'border.bottom', tabs.nodes.map(function (n) { return n.border; }), hasBottom);

    // ---- 图标：四种形态
    var btnIcon = btns.nodes[0].icon && btns.nodes[0].icon[0];
    eq('btn 图标类型', btnIcon && btnIcon.kind, 'svg');
    eq('btn 图标尺寸', btnIcon && btnIcon.size, '16×16');
    record('btn 图标保留了 svg 源码', true, btnIcon && btnIcon.html,
      !!(btnIcon && btnIcon.html.indexOf('M8 3v10M3 8h10') !== -1));

    var ghost = btns.nodes[1];
    var icf = (ghost.icon || []).filter(function (x) { return x.kind === 'iconfont'; })[0];
    eq('iconfont 来源', icf && icf.via, '::before');
    eq('iconfont 字形（已转义）', icf && icf.glyph, '\\e600');
    eq('iconfont 家族', icf && icf.family, 'myicon, Arial, sans-serif');
    eq('iconfont 位置', icf && icf.where, 'i.iconfont.icon-close');

    // 审查发现 6：子节点上的 mask 图标也要报出来
    var cardKinds = (card.icon || []).map(function (x) { return x.kind; }).sort().join(',');
    eq('card 图标四种形态', cardKinds, 'iconfont,img,mask-image,svg');

    var mi = (mask.icon || []).filter(function (x) { return x.kind === 'mask-image'; })[0];
    record('mask 图标被识别', true, mi && mi.value, !!(mi && mi.value.indexOf('data:image/svg+xml') !== -1));

    var imgNode = document.querySelector('img');
    var imgSnap = snap(imgNode);
    var im = (imgSnap.icon || []).filter(function (x) { return x.kind === 'img'; })[0];
    eq('img 图标尺寸', im && im.size, '16×16');
    eq('img 图标来源', im && im.where, 'self');

    // 渐变背景不能被当成图标
    record('hero 不误报图标', null, hero.icon || null, !hero.icon);

    // ---- 审查发现 4 / 9：选择器必须真的能定位回那个元素
    function selResolves(sel, el) {
      var found = sel ? document.querySelectorAll(sel) : [];
      return !!sel && found.length === 1 && found[0] === el;
    }
    var btnEl = document.querySelector('.btn');
    record('snap 的 sel 能定位回元素', true, card.sel, selResolves(card.sel, document.querySelector('#card-a')));
    record('snap(.btn) 的 sel 能定位回元素', true, snap(btnEl).sel, selResolves(snap(btnEl).sel, btnEl));

    var twEl = document.querySelector('.tw-wrap > span');
    var twSel = snap(twEl).sel;
    record('Tailwind 类名（含 : 和 []）能转义成合法选择器', true, twSel, selResolves(twSel, twEl));

    var detached = document.createElement('div');
    detached.className = 'ghost-el';
    record('已脱离文档的元素不给 sel', 'undefined', snap(detached).sel, !('sel' in snap(detached)));

    // ---- 审查发现 5：探针必须用完即删，不能在 DOM 里留东西
    record('探针不残留', 0, document.querySelectorAll('[data-style-snapshot]').length,
      document.querySelectorAll('[data-style-snapshot]').length === 0);

    // ---- 审查发现 14：max:0 不能变成 24
    var zero = snapAll('.btn', { max: 0 });
    eq('max:0 生效', zero.nodes.length, 0);

    // ---- 审查发现 3：批量扫描必须有上限
    var limited = snapAll('.btn', { limit: 2 });
    eq('limit 生效（scanned）', limited.scanned, 2);
    record('limit 生效（标记截断）', true, limited.scanTruncated, !!limited.scanTruncated);

    var failed = checks.filter(function (c) { return !c.pass; });

    return {
      meta: { chrome: navigator.userAgent, customPropsEnumerated: enumerated, tokenCount: Object.keys(tokenTable).length },
      summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length },
      failed: failed,
      sample: {
        btn: btns.nodes[0],
        btnGhost: btns.nodes[1],
        card: card,
        hero: hero,
        variant: variants.nodes,
        tab: tabs.nodes,
        page: pageArr
      }
    };
  }

  var out;
  try {
    out = run();
  } catch (e) {
    out = { fatal: e.name + ': ' + e.message, stack: String(e.stack || '').split('\n').slice(0, 6) };
  }
  var pre = document.createElement('pre');
  pre.id = 'RESULT';
  pre.textContent = JSON.stringify(out, null, 2);
  document.body.appendChild(pre);
});
