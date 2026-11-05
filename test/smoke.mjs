/**
 * client.js 的 DOM 冒烟测试（jsdom，无桌面端）
 *
 * fixture 按真实 DSH CodeBlock 产物构造：
 *  - 未知语言（mermaid）→ plain 分支：<pre class="_plain_*"><code>原始文本</code></pre>，无 span.line
 *  - 已知语言（ts）→ 高亮分支：<code><span class="line">…</span></code>
 *  - banner 是 <div data-code-block-banner="true">，里面有 heading(语言标题) 与 actions(按钮区)
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const banner = (title) => `<div class="_header_1mqf1_10" data-code-block-banner="true">
    <div class="_heading_1mqf1_23"><span class="_language_1mqf1_30">${title}</span></div>
    <div class="_actions_1mqf1_43"><button type="button" class="_action_1mqf1_43" aria-label="Wrap lines">w</button><button type="button" class="_action_1mqf1_43" aria-label="Copy">c</button></div>
  </div>`;
const plainBlock = (id, text) => `  <div class="_block_7gxqk_4 md-code-block _card_7gxqk_107" id="${id}" data-code-wrap="true">
    ${banner('Code block')}
    <div class="_content_7gxqk_60" data-code-block-content><pre class="_plain_7gxqk_103"><code>${text}</code></pre></div>
  </div>`;
const highlightedBlock = (id, lang, text) => `  <div class="_block_7gxqk_4 md-code-block _card_7gxqk_107" id="${id}">
    ${banner(lang)}
    <div data-code-block-content><pre class="shiki css-variables"><code><span class="line">${text}</span></code></pre></div>
  </div>`;

const blocks = `
${plainBlock('b1', 'graph TD\n  A[开始] --&gt; B{判断}\n  B --&gt; C[结束]')}
${plainBlock('b2', 'sequenceDiagram\n  A-&gt;&gt;B: hi')}
${highlightedBlock('b3', 'TypeScript', 'const a: number = 1')}
${plainBlock('b4', 'hello world, just text')}
`;

const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="flow">${blocks}</div></body></html>`, {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
window.document.documentElement.lang = 'zh-CN';

let loaded = null;
const sandbox = {
  window,
  document: window.document,
  console,
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  Date,
};
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = { load(row) { loaded = row; } };
vm.runInNewContext(bundle, sandbox, { filename: 'client.js' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check('模块注册 id 正确', loaded?.id === 'dsh-mermaid', String(loaded?.id));
check('factory 返回 apply', typeof loaded?.factory === 'function');

const api = loaded.factory();
const disposers = [];
api.apply({ effect: (fn) => { disposers.push(fn()); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel, root = window.document) => root.querySelector(sel);

await sleep(400);

const b1 = q('#b1');
const b2 = q('#b2');
const b3 = q('#b3');
const b4 = q('#b4');

const f1 = b1.querySelector('[data-dsh-mermaid-figure]');
check('plain 分支 + mermaid 源码 → 注入 figure', f1 !== null);
check('figure 内含 svg', f1?.querySelector('svg') !== null);
check('原 <pre> 被隐藏', b1.querySelector('pre').style.display === 'none');
check('figure 有 aria-label', (f1?.getAttribute('aria-label') ?? '').includes('Mermaid'));
check('块上打了 enhance 标记', b1.hasAttribute('data-dsh-mermaid-enabled'));

const toggle = b1.querySelector('[data-dsh-mermaid-toggle]');
check('banner 的 actions 区注入了切换按钮', toggle !== null, toggle?.textContent);
check('默认态为图', toggle?.getAttribute('aria-pressed') === 'false');

toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('点一次 → 显示源码', b1.querySelector('pre').style.display === '' && toggle.textContent === '图');
toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('再点一次 → 回到图', b1.querySelector('pre').style.display === 'none' && toggle.textContent === '源码');

// 复制按钮：图态显示「复制图片」，隐藏官方复制源码；源码态反过来
const imageCopy = b1.querySelector('[data-dsh-mermaid-image-copy]');
const officialCopy = b1.querySelector('[data-code-block-banner] button[aria-label="Copy"]');
check('图态：显示「复制图片」按钮', imageCopy !== null && imageCopy.style.display !== 'none', imageCopy?.getAttribute('aria-label'));
check('图态：隐藏官方复制源码按钮', officialCopy !== null && officialCopy.style.display === 'none');
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('源码态：官方复制源码按钮可见', officialCopy !== null && officialCopy.style.display === '');
check('源码态：隐藏「复制图片」按钮', imageCopy !== null && imageCopy.style.display === 'none');
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('回到图态：恢复「复制图片」按钮', imageCopy !== null && imageCopy.style.display !== 'none');

// 标题、wrap 与 zoom 的互换
const titleSpan = b1.querySelector('[data-code-block-banner] span');
check('图态 banner 标题为「渲染图」', (titleSpan?.textContent ?? '').trim() === '渲染图', titleSpan?.textContent);
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('源码态恢复原始标题（Code block）', (titleSpan?.textContent ?? '').trim() === 'Code block', titleSpan?.textContent);
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('回到图态标题又变为「渲染图」', (titleSpan?.textContent ?? '').trim() === '渲染图', titleSpan?.textContent);
const wrapBtn = b1.querySelector('[data-code-block-banner] button[aria-label="Wrap lines"]');
const zoomBtn = b1.querySelector('[data-dsh-mermaid-zoom]');
const shown = (el) => el !== null && el.style.display !== 'none';
check('图态：显示放大按钮', shown(zoomBtn));
check('图态：隐藏官方自动换行', wrapBtn !== null && wrapBtn.style.display === 'none');
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('源码态：恢复官方自动换行', wrapBtn !== null && wrapBtn.style.display === '');
check('源码态：隐藏放大按钮', zoomBtn !== null && zoomBtn.style.display === 'none');
b1.querySelector('[data-dsh-mermaid-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('回到图态：放大按钮恢复', shown(zoomBtn) && wrapBtn.style.display === 'none');

// 点击图本身也能放大（像聊天里的图片一样）
b1.querySelector('[data-dsh-mermaid-figure]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('点击图本身打开预览', window.document.querySelector('.dsh-mermaid-lightbox') !== null);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

// 大图预览
zoomBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const lightbox = window.document.querySelector('.dsh-mermaid-lightbox');
check('点击放大按钮打开预览', lightbox !== null && lightbox.querySelector('svg') !== null);
check('预览是 dialog 且有无障碍名', lightbox?.getAttribute('role') === 'dialog' && (lightbox?.getAttribute('aria-label') ?? '').includes('Mermaid'));
check('预览是浮层面板（panel + 标题栏）', lightbox?.querySelector('.dsh-mermaid-lightbox-panel') !== null && lightbox?.querySelector('.dsh-mermaid-lightbox-title')?.textContent === 'Mermaid');
check('预览含关闭按钮', lightbox?.querySelector('.dsh-mermaid-lightbox-close') !== null);
check('预览含右上缩放按钮组', lightbox?.querySelectorAll('.dsh-mermaid-camera-controls button').length === 3);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Esc 关闭预览', window.document.querySelector('.dsh-mermaid-lightbox') === null);

check('已高亮的语言（TypeScript）不动', !b3.hasAttribute('data-dsh-mermaid-enabled') && b3.querySelector('pre').style.display === '');
check('普通文本代码块（不认识的内容）不动', !b4.hasAttribute('data-dsh-mermaid-enabled'));
check('第二个 mermaid 块也渲染了', b2.querySelector('[data-dsh-mermaid-figure] svg') !== null);

// 流式：新块带半截源码
const flow = q('#flow');
const b5 = window.document.createElement('div');
b5.className = 'md-code-block';
b5.innerHTML = `${banner('Code block')}<div data-code-block-content><pre class="_plain_x"><code>flowchart LR\n  A --&gt;</code></pre></div>`;
flow.append(b5);
await sleep(400);
check('流式半截源码：暂不报错、保留源码', b5.querySelector('.dsh-mermaid-error') === null && b5.querySelector('pre').style.display === '');

await sleep(2300);
const err = b5.querySelector('.dsh-mermaid-error');
check('稳定后语法错误给出可读提示', err !== null && /第 \d+ 行/.test(err.textContent) && /Parse error|Lexical error/.test(err.textContent), err?.textContent?.slice(0, 72));
check('错误显示在图本该出现的位置（figure 内）', b5.querySelector('[data-dsh-mermaid-figure] .dsh-mermaid-error') !== null);
check('错误态与图态一致：源码隐藏', b5.querySelector('pre').style.display === 'none');
check('错误态 banner 显示「渲染图」', (/渲染图/).test(b5.querySelector('[data-code-block-banner]')?.textContent ?? ''));
check('错误态控件与图态一致（放大/复制图片都在）', [b5.querySelector('[data-dsh-mermaid-zoom]'), b5.querySelector('[data-dsh-mermaid-image-copy]')].every((el) => el !== null && el.style.display !== 'none'));
check('错误头部按 pele 格式给出位置与简短原因', /^第 \d+ 行，第 \d+ 列：Parse error/.test(err?.textContent ?? ''));

// 错误态下「复制图片」不能把错误面板里的图标 SVG 当成图复制出去
const errFigure = b5.querySelector('[data-dsh-mermaid-figure]');
check('错误态 figure 里没有可复制的图（图标不是直接子 svg）', ![...(errFigure?.children ?? [])].some((el) => el.tagName.toLowerCase() === 'svg'));
const errCopy = b5.querySelector('[data-dsh-mermaid-image-copy]');
const copyIconBefore = errCopy?.querySelector('svg')?.getAttribute('data-icon') ?? null;
errCopy?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
await sleep(400);
check('错误态点「复制图片」不会复制出图标', (errCopy?.querySelector('svg')?.getAttribute('data-icon') ?? null) === copyIconBefore);
check('出错行与 Expecting 原因作为独立的等宽明细', /Expecting/.test(err?.querySelector('.dsh-mermaid-error-code')?.textContent ?? ''));
const errToggle = b5.querySelector('[data-dsh-mermaid-toggle]');
check('错误态保留「源码」切换', errToggle !== null && errToggle.textContent === '源码');
errToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('切到源码态可以看到原始源码', b5.querySelector('pre').style.display === '' && errToggle.textContent === '图');
check('错误态切到源码后标题恢复原始标题', (b5.querySelector('[data-code-block-banner] span')?.textContent ?? '').trim() === 'Code block', b5.querySelector('[data-code-block-banner] span')?.textContent);
await sleep(1600);
check('源码态不会被错误重渲染拽回图态', b5.querySelector('pre').style.display === '' && errToggle.textContent === '图');
errToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('切回图态显示错误提示', b5.querySelector('pre').style.display === 'none' && b5.querySelector('[data-dsh-mermaid-figure] .dsh-mermaid-error') !== null);

// 语言切换：DSH 的 locale 服务会把当前语言写到 <html lang>
window.document.documentElement.lang = 'en';
await sleep(500);
check('英文：banner 显示 Diagram', (b1.querySelector('[data-code-block-banner] span')?.textContent ?? '').trim() === 'Diagram', b1.querySelector('[data-code-block-banner] span')?.textContent);
check('英文：切换按钮为 Source', b1.querySelector('[data-dsh-mermaid-toggle]')?.textContent === 'Source');
check('英文：错误头部为 Line N, column M', /^Line \d+, column \d+: /.test((b5.querySelector('.dsh-mermaid-error')?.textContent ?? '').trim()), b5.querySelector('.dsh-mermaid-error')?.textContent?.slice(0, 48));
window.document.documentElement.lang = 'zh-CN';
await sleep(500);
check('切回中文：banner 恢复渲染图', (b1.querySelector('[data-code-block-banner] span')?.textContent ?? '').trim() === '渲染图');
check('切回中文：切换按钮恢复源码', b1.querySelector('[data-dsh-mermaid-toggle]')?.textContent === '源码');

await sleep(600);
const zoomBeforeDispose = b2.querySelector('[data-dsh-mermaid-zoom]');
zoomBeforeDispose?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const lightboxOpen = window.document.querySelector('.dsh-mermaid-lightbox') !== null;
for (const d of disposers) d();
check('dispose 关闭已打开的预览', lightboxOpen && window.document.querySelector('.dsh-mermaid-lightbox') === null);
const b6 = window.document.createElement('div');
b6.className = 'md-code-block';
b6.innerHTML = `${banner('Code block')}<div data-code-block-content><pre class="_plain_x"><code>pie\n  "a": 1</code></pre></div>`;
flow.append(b6);
await sleep(400);
check('dispose 后 mutation 不再处理', b6.querySelector('[data-dsh-mermaid-figure]') === null);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
