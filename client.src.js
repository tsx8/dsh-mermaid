/*! dsh-mermaid — MIT License (see LICENSE).
 *  Bundles pele@1.13.0 — MIT, Copyright (c) 2026 kepano — https://github.com/obsidianmd/pele
 *  Third-party notices: THIRD_PARTY_NOTICES.md
 */
/**
 * DSH Mermaid 增强器
 *
 * 目标：assistant 正文里的 ```mermaid 代码块**就地**变成图：
 *   - 默认显示渲染后的图，图态：块内「源码」+「放大」（点击打开大图预览）
 *   - 源码态：块内「图」+ 保留官方的「自动换行」
 *   - 宽图一律等比缩放到容器全宽，不横向滚动（细节交给放大预览）
 *
 * 为什么是 DOM 增强而不是官方扩展点：
 *   DSH 的 Markdown 渲染器把每个 fenced code block 硬编码交给 <CodeBlock>，
 *   没有「按语言注册渲染器」的钩子。
 *
 * 实现原则（尽量不惊动 React）：
 *   1. 不删除、不替换 React 管的 <pre>，只给它加 inline display:none；
 *   2. 在 <pre> 之后插入我们自己的 <figure>（React 不认领这个兄弟节点）；
 *   3. 按钮插进现有 banner 的 actions 区，沿用原生观感；
 *   4. MutationObserver 兜住 React 重渲染 / 流式追加 / 折叠重挂，按源码 hash 幂等；
 *   5. 所有 DOM 写入都先比较再写，避免自激 mutation 循环。
 */
import { render, detectType, PeleError } from 'pele';

const PKG_ID = 'dsh-mermaid';
const BLOCK = '.md-code-block';
const CONTENT = '[data-code-block-content]';
// CodeBlock 的语言栏/复制区用 CSS Module 哈希类名，只有这些 data 属性是稳定的
const BANNER = '[data-code-block-banner]';

/** DSH 会把当前界面语言写回 <html lang>；客户端插件据此取词（无需依赖内部 locale 服务）。 */
const MESSAGES = {
  zh: {
    bannerDiagram: '渲染图',
    toSource: '源码',
    toDiagram: '图',
    zoom: '放大',
    copyImage: '复制图片',
    imageCopied: '已复制图片',
    figureLabel: (width) => `Mermaid 图${width > 0 ? `，宽 ${width} 像素` : ''}，可点击放大`,
    preview: 'Mermaid 图预览',
    previewClose: '关闭预览',
    canvas: 'Mermaid 图：滚轮缩放，拖拽平移，双击复位',
    zoomIn: '放大',
    zoomOut: '缩小',
    resetView: '复位到初始视图',
    where: (line, column) => `第 ${line} 行${column ? `，第 ${column} 列` : ''}`,
    diagnosis: (where, reason) => `${where}：${reason}`,
  },
  en: {
    bannerDiagram: 'Diagram',
    toSource: 'Source',
    toDiagram: 'Diagram',
    zoom: 'Zoom',
    copyImage: 'Copy image',
    imageCopied: 'Image copied',
    figureLabel: (width) => `Mermaid diagram${width > 0 ? `, ${width}px wide` : ''}, click to zoom`,
    preview: 'Mermaid diagram preview',
    previewClose: 'Close preview',
    canvas: 'Mermaid diagram: scroll to zoom, drag to pan, double-click to reset',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset view',
    where: (line, column) => `Line ${line}${column ? `, column ${column}` : ''}`,
    diagnosis: (where, reason) => `${where}: ${reason}`,
  },
};

function activeLang() {
  const declared = (document.documentElement.lang || '').toLowerCase();
  if (declared.startsWith('zh')) return 'zh';
  if (declared.startsWith('en')) return 'en';
  const fallback = (typeof navigator === 'undefined' ? '' : navigator.language || '').toLowerCase();
  return fallback.startsWith('zh') ? 'zh' : 'en';
}

function t(key, ...args) {
  const table = MESSAGES[activeLang()] ?? MESSAGES.zh;
  const value = table[key] ?? MESSAGES.zh[key];
  return typeof value === 'function' ? value(...args) : value;
}
const ATTR_FIG = 'data-dsh-mermaid-figure';
const ATTR_TOGGLE = 'data-dsh-mermaid-toggle';
const ATTR_ZOOM = 'data-dsh-mermaid-zoom';
const ATTR_IMAGE_COPY = 'data-dsh-mermaid-image-copy';
const ATTR_HIDDEN = 'data-dsh-mermaid-hidden';
const DS_STATE = 'dshMermaidState';
const DS_HASH = 'dshMermaidHash';

const DEBOUNCE_MS = 120;
const ERROR_GRACE_MS = 1200; // 源码静默这么久才认定"真的画不出来"（避开流式中的半张图）

/**
 * 图标直接复用 DSH 自己的 sprite（`<use href="#dsw-icon-…">`），
 * 与官方按钮同款 14×14 渲染、同描边宽度，不会因为手画参数不同而显得发虚。
 * 找不到 sprite 时退回同规格的手画版本（14 视图框、1px 描边、1/2 像素对齐）。
 */
const ICON_CANDIDATES = [
  'dsw-icon-fullscreen-outline-regular',
  'dsw-icon-inspect-outline-regular',
  'dsw-icon-search-outline-regular',
];
const FALLBACK_ICON =
  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 2.5H2.5V5"/><path d="M9 2.5h2.5V5"/><path d="M5 11.5H2.5V9"/><path d="M9 11.5h2.5V9"/>' +
  '</svg>';

function expandIconMarkup() {
  for (const id of ICON_CANDIDATES) {
    if (document.getElementById(id) !== null) {
      return `<svg width="14" height="14" data-icon="${id}" aria-hidden="true"><use href="#${id}"></use></svg>`;
    }
  }
  return FALLBACK_ICON;
}

// Pele ← DSH 主题 token 映射：图容器与大图预览共用同一套变量
const THEME_VARS = `
  --pele-fg: var(--dsw-alias-label-primary);
  --pele-muted: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  --pele-line: var(--dsw-alias-label-secondary);
  --pele-surface: var(--dsw-alias-bg-base);
  --pele-surface-alt: var(--dsw-alias-bg-layer-1);
  --pele-border: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  --pele-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  --pele-critical: var(--dsw-alias-state-error-primary);
  --pele-error: var(--dsw-alias-state-error-primary);
  --pele-font: inherit;
  --pele-font-mono: var(--dsh-font-family-code, ui-monospace, monospace);
  --pele-radius: 6px;
`;

const CSS = `
.dsh-mermaid-figure {
  ${THEME_VARS}
  /* 连线标签用 fill="var(--_bg)"（即 --pele-bg）的遮罩块挡住线；
     必须等于卡片实际底色，否则线会从文字下面穿过去 */
  --pele-bg: var(--dsw-specific-sidebar-fill);
  margin: 0;
  padding: 10px 16px 16px;
  /* 会话内不限制高度：全宽 + 自然高度，任何时候都完整展示、不出现内嵌滚动 */
  display: block;
  overflow: visible;
  background: transparent;
  cursor: zoom-in;
}
.dsh-mermaid-figure[hidden] { display: none; }
.dsh-mermaid-figure > svg {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  width: auto;
  height: auto;
  /* 不设 max-height：高度只由图自身长宽比与宽度决定 */
}

.dsh-mermaid-toggle,
.dsh-mermaid-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  /* 与官方 CodeCard .action 一致 */
  height: 24px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dsh-mermaid-toggle { width: auto; padding: 0 7px; }
.dsh-mermaid-icon { width: 24px; }
@media (hover: hover) {
  .dsh-mermaid-toggle:hover,
  .dsh-mermaid-icon:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.dsh-mermaid-toggle[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary);
}
.dsh-mermaid-toggle:focus-visible,
.dsh-mermaid-icon:focus-visible {
  outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-mermaid-icon > svg { display: block; }

/* 官方 Tooltip.module.css 的视觉复刻（类名加前缀，颜色/圆角走 token） */
.dsh-mermaid-tooltip {
  position: fixed;
  z-index: 1100;
  display: none;
  align-items: safe center;
  gap: 8px;
  width: max-content;
  box-sizing: border-box;
  max-width: min(50vw, calc(100vw - 24px));
  padding: 3px 7px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-overlay));
  color: var(--dsw-static-neutral-bluish-00, var(--dsw-alias-label-primary));
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
}
.dsh-mermaid-tooltip[data-open="true"] { display: inline-flex; animation: dsh-mermaid-tooltip-in 150ms var(--ds-ease-in-out, ease-out); }
@keyframes dsh-mermaid-tooltip-in { from { opacity: 0; } to { opacity: 1; } }

.dsh-mermaid-figure[data-error="true"] { cursor: default; }
.dsh-mermaid-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 20px;
}
.dsh-mermaid-error[hidden] { display: none; }
.dsh-mermaid-error-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dsh-mermaid-error-line > svg {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mermaid-error-code {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 大图预览：居中浮层面板（保留上一版视觉，不采用全屏看图样式） */
.dsh-mermaid-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.dsh-mermaid-lightbox-panel {
  ${THEME_VARS}
  --pele-bg: var(--dsw-alias-bg-base);
  display: flex;
  flex-direction: column;
  max-width: 94vw;
  max-height: 88vh;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}
.dsh-mermaid-lightbox-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dsh-mermaid-lightbox-title { flex: 1 1 auto; }
.dsh-mermaid-lightbox-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.dsh-mermaid-lightbox-close:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-mermaid-lightbox-body { padding: 6px 16px 16px; }
.dsh-mermaid-zoom-stage {
  position: relative;
  display: block;
  overflow: hidden;
  touch-action: none;
  outline: none;
  cursor: grab;
  background: transparent;
}
.dsh-mermaid-zoom-stage[data-dragging="true"] { cursor: grabbing; }
.dsh-mermaid-zoom-stage > svg { display: block; width: 100%; height: 100%; }
.dsh-mermaid-zoom-stage:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.dsh-mermaid-camera-controls {
  position: absolute;
  top: 8px;
  inset-inline-end: 8px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
}
.dsh-mermaid-camera-button {
  appearance: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-mermaid-camera-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-mermaid-camera-button:disabled { opacity: 0.35; cursor: default; }
.dsh-mermaid-camera-button > svg { display: block; }
`;

/** 每块的派生状态；WeakMap 不污染 DOM，也不阻止节点回收。 */
const blockState = new WeakMap();

/** 当前打开的预览的关闭函数（同一时间只允许一个）。 */
let closeLightbox = null;

function stateFor(block, now) {
  let state = blockState.get(block);
  if (state === undefined) {
    state = { hash: '', renderedHash: '', changedAt: now, error: undefined, svg: '', type: '', hasFigure: false, width: 0 };
    blockState.set(block, state);
  }
  return state;
}

/** 从 <pre> 取源码：优先按 shiki/plain 的 span.line 拼行，回退 textContent。 */
function sourceOf(pre) {
  const code = pre.querySelector('code') ?? pre;
  const lines = code.querySelectorAll('span.line');
  if (lines.length > 0) {
    return Array.from(lines, (line) => line.textContent ?? '').join('\n');
  }
  return (code.textContent ?? '').replace(/\n+$/, '');
}

/**
 * DSH 的语法高亮器不认识 mermaid：该 fence 会走 CodeBlock 的 plain 分支
 * （<pre class=_plain_><code>原始文本</code>，没有 shiki 的 span.line），
 * banner 标题退化成通用 "Code block"，DOM 里没有任何 language 标记。
 * 因此用两个信号组合判断：plain 分支 + pele 的 detectType 能识别出图类型。
 */
function isPlainCode(pre) {
  const code = pre.querySelector('code');
  if (code === null) return true;
  return code.children.length === 0;
}

function detectMermaid(source) {
  try {
    return detectType(source) ?? null;
  } catch {
    return null;
  }
}

function hashOf(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return String(hash);
}

function renderSafely(source, maxWidth) {
  try {
    const result = render(source, maxWidth > 0 ? { maxWidth } : undefined);
    return { ok: true, svg: result.svg, type: result.mermaidType ?? result.type, width: result.width, height: result.height };
  } catch (error) {
    if (error instanceof PeleError) {
      return { ok: false, code: error.code, line: error.line, column: error.column, message: error.message, snippet: error.snippet };
    }
    throw error;
  }
}

function stateOf(block) {
  return block.dataset[DS_STATE] === 'source' ? 'source' : 'diagram';
}

/**
 * banner 标题：图态显示「渲染图」，源码态恢复 DSH 原本的标题（"Code block" / "代码块"）。
 * 原始标题在第一次改动前记录，React 重渲染换掉 span 时重新记录。
 */
const BANNER_LABELS = new WeakMap(); // block -> { span, original }

function bannerSpan(block) {
  const banner = block.querySelector(BANNER);
  if (banner === null) return null;
  const heading = banner.firstElementChild;
  return heading?.querySelector('span') ?? heading;
}

function setBannerLabel(block, label) {
  const span = bannerSpan(block);
  if (span === null) return;
  const known = BANNER_LABELS.get(block);
  if (known === undefined || known.span !== span) {
    BANNER_LABELS.set(block, { span, original: span.textContent ?? '' });
  }
  if (span.textContent !== label) span.textContent = label;
}

/** 源码态的标题 = 增强前的原始标题。 */
function originalBannerLabel(block) {
  const known = BANNER_LABELS.get(block);
  if (known !== undefined && known.span === bannerSpan(block)) return known.original;
  const span = bannerSpan(block);
  return span?.textContent ?? '';
}

function bannerActions(block) {
  const banner = block.querySelector(BANNER);
  if (banner === null) return null;
  const actions = banner.lastElementChild;
  if (actions === null || actions === banner.firstElementChild) return null;
  return actions;
}

/** 官方的「自动换行」按钮（哈希类名不可用，用 aria-label / 图标名兜底识别）。 */
function officialWrapButton(block) {
  const actions = bannerActions(block);
  if (actions === null) return null;
  const buttons = Array.from(actions.querySelectorAll('button'));
  return (
    buttons.find((b) => /wrap|换行/i.test(b.getAttribute('aria-label') ?? '')) ??
    buttons.find((b) => b.querySelector('svg[data-icon*="wrap"]') !== null) ??
    null
  );
}

/** 官方的复制按钮（图态下改为复制图片）。 */
function officialCopyButton(block) {
  const actions = bannerActions(block);
  if (actions === null) return null;
  const buttons = Array.from(actions.querySelectorAll('button'));
  return (
    buttons.find((b) => /copy|复制/i.test(b.getAttribute('aria-label') ?? '')) ??
    null
  );
}

/**
 * 复刻官方 Tooltip：hover / 键盘 focus 时在锚点上方显示气泡（顶部放不下则翻到下方），
 * 文案由 getLabel() 实时求值；气泡挂在 body 上避免被卡片裁切。
 */
const tooltipBindings = new Map();
let tooltipSeq = 0;

function attachTooltip(anchor, getLabel) {
  if (tooltipBindings.has(anchor)) return;
  const bubble = document.createElement('span');
  bubble.className = 'dsh-mermaid-tooltip';
  bubble.setAttribute('role', 'tooltip');
  const id = `dsh-mermaid-tooltip-${++tooltipSeq}`;
  bubble.id = id;
  anchor.setAttribute('aria-describedby', id);

  let open = false;
  const place = () => {
    const label = getLabel();
    if (label === '') return;
    bubble.textContent = label;
    if (bubble.parentNode !== document.body) document.body.append(bubble);
    bubble.dataset.open = 'true';
    bubble.style.visibility = 'hidden';
    const rect = anchor.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const half = width / 2;
    const left = Math.min(Math.max(rect.left + rect.width / 2, 12 + half), window.innerWidth - 12 - half);
    let top = rect.top - 8;
    let side = 'top';
    if (top - height < 12) {
      side = 'bottom';
      top = rect.bottom + 8;
    }
    bubble.dataset.side = side;
    bubble.style.transform = side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    bubble.style.visibility = '';
    open = true;
  };
  const hide = () => {
    if (!open) return;
    open = false;
    bubble.dataset.open = 'false';
    if (!anchor.isConnected) detach();
  };
  const reveal = () => {
    if (!anchor.isConnected) return;
    place();
  };
  const onLeave = () => hide();
  const onBlur = () => hide();
  const onDown = () => hide();
  const onScroll = () => hide();

  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    bubble.remove();
    anchor.removeEventListener('pointerenter', reveal);
    anchor.removeEventListener('pointerleave', onLeave);
    anchor.removeEventListener('focus', reveal);
    anchor.removeEventListener('blur', onBlur);
    anchor.removeEventListener('pointerdown', onDown);
    window.removeEventListener('scroll', onScroll, true);
    anchor.removeAttribute('aria-describedby');
    tooltipBindings.delete(anchor);
  };

  anchor.addEventListener('pointerenter', reveal);
  anchor.addEventListener('pointerleave', onLeave);
  anchor.addEventListener('focus', reveal);
  anchor.addEventListener('blur', onBlur);
  anchor.addEventListener('pointerdown', onDown);
  window.addEventListener('scroll', onScroll, true);
  // refresh：气泡开着时按最新 label 重排（官方 Tooltip 的 label 是实时求值的）
  const refresh = () => {
    if (open) place();
  };
  tooltipBindings.set(anchor, { detach, refresh, hide });
}

function refreshTooltip(anchor) {
  tooltipBindings.get(anchor)?.refresh();
}

function hideTooltip(anchor) {
  tooltipBindings.get(anchor)?.hide();
}

function disposeTooltips() {
  for (const { detach } of [...tooltipBindings.values()]) detach();
}

/**
 * 把渲染好的 SVG 光栅化成 PNG 写进剪贴板。
 * 关键点：SVG 里的颜色都是 `var(--pele-*)`，脱离页面后没有定义，所以先把
 * getComputedStyle 里解析好的变量值写进克隆节点，再序列化、经 <img> 画到 canvas。
 */
async function copyDiagramImage(block, button) {
  const figure = block.querySelector(`[${ATTR_FIG}]`);
  // 只复制真正的渲染图；错误面板里的图标 SVG 不能当图复制
  const svg = diagramSvg(figure);
  if (svg === null) return false;

  const clone = svg.cloneNode(true);
  const computed = getComputedStyle(figure);
  const VARS = [
    'bg', 'fg', 'fg-on-light', 'fg-on-dark', 'muted', 'line', 'surface', 'surface-alt',
    'border', 'accent', 'critical', 'error', 'radius', 'title-weight', 'heading-weight', 'bold-weight',
  ];
  for (const name of VARS) {
    const value = computed.getPropertyValue(`--pele-${name}`).trim();
    if (value !== '') clone.style.setProperty(`--pele-${name}`, value);
  }
  const fontFamily = computed.fontFamily || 'sans-serif';
  const monoFamily = computed.getPropertyValue('--pele-font-mono').trim() || 'ui-monospace, monospace';
  clone.style.setProperty('--pele-font', fontFamily);
  clone.style.setProperty('--pele-font-mono', monoFamily);
  clone.style.fontFamily = fontFamily;

  const vb = svg.viewBox?.baseVal;
  const width = Math.max(1, Math.round(vb?.width ? vb.width : svg.getBoundingClientRect().width));
  const height = Math.max(1, Math.round(vb?.height ? vb.height : svg.getBoundingClientRect().height));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const background = computed.getPropertyValue('--pele-bg').trim();
  const paint = background !== '' ? background : '#ffffff';
  const svgText = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG 光栅化失败'));
      image.src = url;
    });
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d 不可用');
    context.fillStyle = paint;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (pngBlob === null) throw new Error('PNG 编码失败');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeIconButton(block, attr, title, iconHtml, onClick) {
  const existing = block.querySelector(`[${attr}]`);
  if (existing !== null) return existing;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-mermaid-icon';
  button.setAttribute(attr, '');
  button.setAttribute('aria-label', title);
  button.innerHTML = iconHtml;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(block);
  });
  attachTooltip(button, () => button.getAttribute('aria-label') ?? '');
  return button;
}

function ensureToggle(block) {
  const existing = block.querySelector(`[${ATTR_TOGGLE}]`);
  if (existing !== null) return existing;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-mermaid-toggle';
  button.setAttribute(ATTR_TOGGLE, '');
  button.setAttribute('aria-pressed', 'false');
  button.textContent = t('toSource');

  const actions = bannerActions(block);
  if (actions !== null) {
    actions.insertBefore(button, actions.firstElementChild ?? null);
    return button;
  }

  // showHeader=false（没有 banner）时：挂在 figure 里
  const figure = block.querySelector(`[${ATTR_FIG}]`);
  if (figure === null) return null;
  button.classList.add('dsh-mermaid-toggle-floating');
  figure.prepend(button);
  return button;
}

function ensureZoom(block) {
  const existing = block.querySelector(`[${ATTR_ZOOM}]`);
  if (existing !== null) return existing;
  const actions = bannerActions(block);
  if (actions === null) return null;
  const button = makeIconButton(block, ATTR_ZOOM, t('zoom'), expandIconMarkup(), openLightbox);
  const toggle = block.querySelector(`[${ATTR_TOGGLE}]`);
  if (toggle !== null) toggle.insertAdjacentElement('afterend', button);
  else actions.insertBefore(button, actions.firstElementChild ?? null);
  return button;
}

/** 隐藏外部元素必须用 inline display：官方按钮自带 display:inline-flex，hidden 属性压不住。 */
/** 图态专用：复制渲染结果（PNG）。位置与官方复制按钮同一槽位，成功后图标换勾 1s（与官方一致）。 */
function ensureImageCopy(block) {
  const existing = block.querySelector(`[${ATTR_IMAGE_COPY}]`);
  if (existing !== null) return existing;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-mermaid-icon';
  button.setAttribute(ATTR_IMAGE_COPY, '');
  button.setAttribute('aria-label', t('copyImage'));
  button.innerHTML = spriteIcon('dsw-icon-copy-outline-regular', COPY_FALLBACK);
  // 官方 hover 提示是固定文案，成功反馈只体现在图标上
  attachTooltip(button, () => t('copyImage'));

  let resetTimer = 0;
  const setIcon = (iconId, fallback) => {
    button.innerHTML = spriteIcon(iconId, fallback);
  };
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.busy === 'true') return;
    button.dataset.busy = 'true';
    let ok = false;
    try {
      ok = await copyDiagramImage(block, button);
    } catch (error) {
      console.warn('[dsh-mermaid] 复制图片失败', error);
    } finally {
      button.dataset.busy = 'false';
    }
    // 与官方一致：失败不提示，成功只把图标切成 ✓（1000ms），不弹任何文案
    if (!ok) return;
    setIcon('dsw-icon-check-outline-regular', CHECK_FALLBACK);
    button.setAttribute('aria-label', t('imageCopied'));
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      if (!button.isConnected) return;
      setIcon('dsw-icon-copy-outline-regular', COPY_FALLBACK);
      button.setAttribute('aria-label', t('copyImage'));
    }, 1000);
  });

  const actions = bannerActions(block);
  if (actions === null) return null;
  actions.append(button);
  return button;
}

function setShown(el, shown) {
  if (el === null) return;
  const display = shown ? '' : 'none';
  if (el.style.display !== display) el.style.display = display;
}

function setHidden(el, hidden) {
  if (el !== null && el.hidden !== hidden) el.hidden = hidden;
}

/** figure 里真正的渲染图（直接子 SVG）；错误面板内的图标 SVG 不算。 */
function diagramSvg(figure) {
  if (figure === null) return null;
  for (const child of figure.children) {
    if (child.tagName.toLowerCase() === 'svg') return child;
  }
  return null;
}

/** 把「图 / 源码」状态的显隐同步到 DOM，每次写入前都比较，避免自激。 */
function sync(block) {
  const pre = block.querySelector(`${CONTENT} > pre`);
  const figure = block.querySelector(`[${ATTR_FIG}]`);
  const error = block.querySelector('.dsh-mermaid-error');
  if (pre === null) return;
  const showSource = stateOf(block) === 'source';
  const display = showSource ? '' : 'none';
  if (pre.style.display !== display) pre.style.display = display;
  if (pre.hasAttribute(ATTR_HIDDEN) === showSource) pre.toggleAttribute(ATTR_HIDDEN, !showSource);
  const hasSvg = diagramSvg(figure) !== null;
  const hasError = figure !== null && figure.querySelector('.dsh-mermaid-error') !== null;
  setHidden(figure, showSource || (!hasSvg && !hasError));
  setHidden(error, showSource);

  setBannerLabel(block, showSource ? originalBannerLabel(block) : t('bannerDiagram'));

  const toggle = block.querySelector(`[${ATTR_TOGGLE}]`);
  if (toggle !== null) {
    const text = showSource ? t('toDiagram') : t('toSource');
    if (toggle.textContent !== text) toggle.textContent = text;
    const pressed = showSource ? 'true' : 'false';
    if (toggle.getAttribute('aria-pressed') !== pressed) toggle.setAttribute('aria-pressed', pressed);

  }

  // 图态（含错误态）：控件与正常渲染时完全一致
  setShown(block.querySelector(`[${ATTR_ZOOM}]`), !showSource);
  setShown(officialWrapButton(block), showSource);
  // 图态：隐藏官方「复制源码」；源码态反过来
  setShown(officialCopyButton(block), showSource);
  const imageCopy = ensureImageCopy(block);
  setShown(imageCopy, !showSource);
  if (showSource) hideTooltip(imageCopy);
  refreshTooltip(toggle);
}

/**
 * 与 pele playground 的 showError() 同构：
 *   头部 = diagnosis()（位置 + 首行原因）
 *   正文 = message 去掉首行后的 remainder（出错行 + caret + Expecting …）
 */
function errorView(error) {
  const raw = String(error.message ?? '').trim();
  const lines = raw.split('\n');
  if (error.code === 'unsupported-diagram') {
    return { text: lines[0] ?? raw, detail: lines.slice(1).join('\n') };
  }
  const reason = (lines[0] ?? '').replace(/ on line \d+/i, '').replace(/:$/, '').trim();
  const where = error.line ? t('where', error.line, error.column) : '';
  const rest = lines.slice(1);
  const snippet = String(error.snippet ?? '');
  const detail = (snippet !== '' && !raw.includes(snippet) ? [snippet, ...rest] : rest).join('\n').trimEnd();
  return { text: where === '' ? reason : t('diagnosis', where, reason), detail };
}

function errorPanel(error) {
  const view = errorView(error);
  const box = document.createElement('div');
  box.className = 'dsh-mermaid-error';
  box.setAttribute('role', 'note');

  const line = document.createElement('div');
  line.className = 'dsh-mermaid-error-line';
  // Lucide triangle-alert（24 视图框，2px 描边），与 pele playground 一致
  line.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const text = document.createElement('span');
  text.textContent = view.text;
  line.append(text);
  box.append(line);

  if (view.detail !== '') {
    const detail = document.createElement('pre');
    detail.className = 'dsh-mermaid-error-code';
    detail.textContent = view.detail;
    box.append(detail);
  }
  return box;
}

/**
 * 语法错误时占住"图本该出现的位置"：与图态同样隐藏源码、保留 banner 与「源码」切换，
 * 只是画布内容换成错误面板；放大/复制图片在这种状态下没有对象，不显示。
 */
function showError(block, pre, error) {
  let figure = block.querySelector(`[${ATTR_FIG}]`);
  if (figure === null) {
    figure = document.createElement('figure');
    figure.className = 'dsh-mermaid-figure';
    figure.setAttribute(ATTR_FIG, '');
    pre.insertAdjacentElement('afterend', figure);
  }
  const signature = hashOf(JSON.stringify(errorView(error)));
  if (figure.getAttribute('data-error') !== signature) {
    figure.setAttribute('data-error', signature);
    figure.innerHTML = '';
    figure.append(errorPanel(error));
  }
  figure.hidden = false;

  setBannerLabel(block, t('bannerDiagram'));
  ensureToggle(block);
  ensureZoom(block);
  ensureImageCopy(block);
  block.dataset[DS_STATE] = 'diagram';
  sync(block);
}

function clearError(block) {
  const figure = block.querySelector(`[${ATTR_FIG}]`);
  if (figure !== null) {
    figure.querySelector('.dsh-mermaid-error')?.remove();
    figure.removeAttribute('data-error');
  }
  block.querySelectorAll('.dsh-mermaid-error').forEach((node) => node.remove());
  setShown(block.querySelector(`[${ATTR_TOGGLE}]`), true);
}

function renderInto(block, pre, state, result) {
  let figure = block.querySelector(`[${ATTR_FIG}]`);
  if (figure === null) {
    figure = document.createElement('figure');
    figure.className = 'dsh-mermaid-figure';
    figure.setAttribute(ATTR_FIG, '');
    pre.insertAdjacentElement('afterend', figure);
    state.svg = '';
  }
  if (state.svg !== result.svg) {
    figure.removeAttribute('data-error');
    figure.innerHTML = result.svg;
    state.svg = result.svg;
  }
  figure.hidden = false;
  const natural = Math.round(result.width ?? 0);
  state.width = natural;
  const label = t('figureLabel', natural);
  if (figure.getAttribute('aria-label') !== label) figure.setAttribute('aria-label', label);
  clearError(block);
  ensureToggle(block);
  ensureZoom(block);
  ensureImageCopy(block);
  labelBanner(block);
  if (block.dataset[DS_STATE] === undefined) block.dataset[DS_STATE] = 'diagram';
  sync(block);
}

const PLUS_FALLBACK =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"/><path d="M8 4v8"/></svg>';
const MINUS_FALLBACK =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"/></svg>';
const COPY_FALLBACK =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
const CLOSE_FALLBACK =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const CHECK_FALLBACK =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

const RESET_FALLBACK =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4"/><path d="M3 3v2.8h2.8"/></svg>';

/** 复用 DSH 的图标 sprite；找不到时退回同规格手画版（16 视图框、1px 描边）。 */
function spriteIcon(id, fallback) {
  return document.getElementById(id) !== null
    ? `<svg width="14" height="14" data-icon="${id}" aria-hidden="true"><use href="#${id}"></use></svg>`
    : fallback;
}

/**
 * 相机：移植自 Pele 的 `src/zoom.ts`（MIT，v1.13.0），保留其 viewBox 数学与手势逻辑。
 *
 * 与上游的差异只有 4 处（其余逐段照搬）：
 *   1. 画布固定为元素自身的 clientWidth/Height（上游用"图当前渲染尺寸"作为 rest）；
 *   2. `fit` 取 `min(box.w/natW, box.h/natH)`（上游只按宽度），保证长图也能整图可见；
 *   3. 缩放下限降到 `fit × minScale`（上游锁死在 fit），并去掉"到 fit 就 settle"；
 *   4. 静止态（scale === fit）也允许拖拽——`frame()` 的上游钳制本来就把"图小于视图"的情形
 *      限制在视图内，所以拖拽天然有边界；`settle()` 只是"复位到居中 fit"。
 *
 * 上游保留未动的部分：`frame()` 的钳制公式、`show()` 的指针锚定推导（pointX/pointY）、
 * 双指缩放、Safari gesture 事件、拖动后抑制 click、focus-visible 处理、ResizeObserver 复位。
 */
function createCamera(element, svg, onState) {
  const MIN_SCALE = 0.35;
  const MAX_SCALE = 8;
  const STEP = 1.25;
  const PAN = 48;

  const natural = { width: 0, height: 0 };
  const box = { width: 0, height: 0 };
  let restStyle = { width: '', height: '', maxWidth: '', margin: '', display: '' };
  let scale = 1;
  let x = 0;
  let y = 0;

  const view = () => element.ownerDocument?.defaultView ?? globalThis;
  const fit = () =>
    natural.width > 0 && box.width > 0 && natural.height > 0 && box.height > 0
      ? Math.min(box.width / natural.width, box.height / natural.height)
      : 1;
  const least = () => fit() * MIN_SCALE;
  const most = () => Math.max(fit() * MAX_SCALE, 4);

  // 上游 frame()：视图大于图时整图留在视图内（可平移但不出框），小于图时停在图边缘
  const frame = (naturalSize, boxSize, atScale, atX, atY) => {
    const width = boxSize.width / atScale;
    const height = boxSize.height / atScale;
    const within = (at, viewSize, whole) =>
      viewSize >= whole ? Math.min(Math.max(at, whole - viewSize), 0) : Math.min(Math.max(at, 0), whole - viewSize);
    return {
      x: within(atX, width, naturalSize.width),
      y: within(atY, height, naturalSize.height),
      width,
      height,
    };
  };

  const emit = () => onState?.({ scale, fit: fit(), least: least(), most: most() });

  const place = (toX, toY) => {
    const shown = frame(natural, box, scale, toX, toY);
    x = shown.x;
    y = shown.y;
    svg.setAttribute('viewBox', `${x} ${y} ${shown.width} ${shown.height}`);
    emit();
  };

  const center = () => {
    place((natural.width - box.width / scale) / 2, (natural.height - box.height / scale) / 2);
  };

  const settle = () => {
    const next = fit();
    scale = next > 0 ? next : 1;
    center();
  };

  const measure = () => {
    box.width = element.clientWidth || element.getBoundingClientRect().width;
    box.height = element.clientHeight || element.getBoundingClientRect().height;
    svg.style.maxWidth = 'none';
    svg.style.margin = '0';
    svg.style.display = 'block';
    svg.style.width = `${Math.max(box.width, 1)}px`;
    svg.style.height = `${Math.max(box.height, 1)}px`;
  };

  const show = (next, clientX, clientY) => {
    if (natural.width <= 0 || box.width <= 0) return;
    const from = scale;
    const to = Math.min(Math.max(next, least()), most());
    if (!Number.isFinite(to) || Math.abs(to - from) < 1e-6) return;
    const rect = element.getBoundingClientRect();
    const atX = clientX ?? rect.left + rect.width / 2;
    const atY = clientY ?? rect.top + rect.height / 2;
    // 上游的指针锚定推导：先记录指针下的图上坐标，换算新比例后再反推视图左上角
    const pointX = x + (atX - rect.left) / from;
    const pointY = y + (atY - rect.top) / from;
    scale = to;
    place(pointX - (atX - rect.left) / scale, pointY - (atY - rect.top) / scale);
  };

  const move = (dx, dy) => {
    if (scale <= 0) return;
    place(x - dx / scale, y - dy / scale);
  };

  const pointers = new Map();
  let dragged = false;
  let travelled = 0;
  let pinch = 0;
  let gesture = 0;

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const ours = (event) =>
    event.target instanceof Element && event.target.closest('.dsh-mermaid-camera-controls') !== null;

  const onPress = () => {
    dragged = false;
  };

  const onPointerDown = (event) => {
    if (ours(event) || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled = 0;
    if (pointers.size === 2) pinch = spread().distance;
    element.setPointerCapture?.(event.pointerId);
    element.dataset.dragging = 'true';
  };

  const onPointerMove = (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    if (pointers.size === 2) {
      const before = spread();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const now = spread();
      if (pinch > 0 && now.distance > 0) show(scale * (now.distance / before.distance), now.x, now.y);
      move(now.x - before.x, now.y - before.y);
      dragged = true;
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    travelled += Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y);
    if (travelled > 4) dragged = true;
    move(event.clientX - last.x, event.clientY - last.y);
  };

  const onPointerUp = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    pinch = 0;
    if (pointers.size === 0) delete element.dataset.dragging;
  };

  const onClick = (event) => {
    if (!dragged || event.detail === 0) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onWheel = (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || true) {
      // 模态画布里没有页面可滚，裸滚轮也用于缩放（上游只在按住 Ctrl/⌘ 时缩放）
      const turn = Math.min(Math.max(-event.deltaY, -24), 24);
      show(scale * 2 ** (turn * 0.02), event.clientX, event.clientY);
    }
  };

  const onDoubleClick = (event) => {
    if (ours(event)) return;
    event.preventDefault();
    settle();
  };

  const onKeyDown = (event) => {
    if (ours(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === '+' || key === '=') show(scale * STEP);
    else if (key === '-' || key === '_') show(scale / STEP);
    else if (key === '0' || key === 'Escape') settle();
    else if (key === 'ArrowLeft') move(PAN, 0);
    else if (key === 'ArrowRight') move(-PAN, 0);
    else if (key === 'ArrowUp') move(0, PAN);
    else if (key === 'ArrowDown') move(0, -PAN);
    else return;
    event.preventDefault();
  };

  const onFocus = (event) => {
    if (event.target !== element) return;
    let visible = true;
    try {
      visible = element.matches(':focus-visible');
    } catch {
      /* 老 Safari 不支持 :focus-visible */
    }
    element.style.outline = visible ? '' : 'none';
  };

  const onGestureStart = (event) => {
    event.preventDefault();
    gesture = scale;
  };
  const onGestureChange = (event) => {
    if (gesture === 0) return;
    event.preventDefault();
    const detail = event;
    show(gesture * detail.scale, detail.clientX, detail.clientY);
  };
  const onGestureEnd = () => {
    gesture = 0;
  };

  const listeners = [
    ['pointerdown', onPress, { capture: true }],
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['click', onClick, { capture: true }],
    ['dblclick', onDoubleClick],
    ['keydown', onKeyDown],
    ['focusin', onFocus],
    ['wheel', onWheel, { passive: false }],
    ['gesturestart', onGestureStart, { passive: false }],
    ['gesturechange', onGestureChange, { passive: false }],
    ['gestureend', onGestureEnd, { passive: false }],
  ];
  for (const [type, listener, how] of listeners) element.addEventListener(type, listener, how);

  let watched = 0;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const size = element.clientWidth + element.clientHeight;
          if (size === watched) return;
          watched = size;
          measure();
          settle(); // 画布尺寸变化 = 重置到居中 fit（与上游 resized() 一致）
        })
      : null;
  observer?.observe(element);

  // —— 初始化：从"居中 fit"开始，而不是上游的 scale=0 静止态 ——
  natural.width = Number(svg.getAttribute('width')) || svg.viewBox?.baseVal?.width || 0;
  natural.height = Number(svg.getAttribute('height')) || svg.viewBox?.baseVal?.height || 0;
  restStyle = {
    width: svg.style.width,
    height: svg.style.height,
    maxWidth: svg.style.maxWidth,
    margin: svg.style.margin,
    display: svg.style.display,
  };
  if (!(natural.width > 0) || !(natural.height > 0)) {
    const rect = svg.getBoundingClientRect();
    natural.width = rect.width;
    natural.height = rect.height;
  }
  measure();
  watched = element.clientWidth + element.clientHeight;
  if (natural.width > 0 && natural.height > 0) settle();

  return {
    settle,
    zoomBy: (factor) => show(scale * factor),
    destroy() {
      observer?.disconnect();
      for (const [type, listener, how] of listeners) element.removeEventListener(type, listener, how);
      svg.style.width = restStyle.width;
      svg.style.height = restStyle.height;
      svg.style.maxWidth = restStyle.maxWidth;
      svg.style.margin = restStyle.margin;
      svg.style.display = restStyle.display;
      delete element.dataset.dragging;
      delete element.dataset.zoomed;
    },
  };
}

/** 大图预览：居中浮层面板 + 固定画布（保留上一版视觉）。 */
function openLightbox(block) {
  closeLightbox?.();

  const figure = block.querySelector(`[${ATTR_FIG}]`);
  const inlineSvg = diagramSvg(figure);
  if (inlineSvg === null || inlineSvg === undefined) return;

  const overlay = document.createElement('div');
  overlay.className = 'dsh-mermaid-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('preview'));

  const panel = document.createElement('div');
  panel.className = 'dsh-mermaid-lightbox-panel';

  const head = document.createElement('div');
  head.className = 'dsh-mermaid-lightbox-head';
  const title = document.createElement('span');
  title.className = 'dsh-mermaid-lightbox-title';
  title.textContent = 'Mermaid';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dsh-mermaid-lightbox-close';
  close.setAttribute('aria-label', t('previewClose'));
  close.textContent = '✕';
  head.append(title, close);

  // 固定画布：尺寸只随窗口变化，与图形长宽比无关
  const stageWidth = Math.round(Math.min(Math.max(window.innerWidth * 0.94 - 34, 560), 1680));
  const stageHeight = Math.round(Math.min(Math.max(window.innerHeight * 0.8, 360), 980));
  panel.style.width = `${stageWidth + 34}px`;

  const body = document.createElement('div');
  body.className = 'dsh-mermaid-lightbox-body';

  const stage = document.createElement('div');
  stage.className = 'dsh-mermaid-zoom-stage';
  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
  stage.tabIndex = 0;
  stage.setAttribute('role', 'application');
  stage.setAttribute('aria-label', t('canvas'));

  const svg = inlineSvg.cloneNode(true);

  // 右上角缩放按钮：不加 tooltip（只保留 aria-label）
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'dsh-mermaid-camera-button';
  zoomIn.setAttribute('aria-label', t('zoomIn'));
  zoomIn.setAttribute('data-dsh-mermaid-action', 'in');
  zoomIn.innerHTML = spriteIcon('dsw-icon-plus-outline-regular', PLUS_FALLBACK);
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'dsh-mermaid-camera-button';
  zoomOut.setAttribute('aria-label', t('zoomOut'));
  zoomOut.setAttribute('data-dsh-mermaid-action', 'out');
  zoomOut.innerHTML = spriteIcon('dsw-icon-minus-outline-regular', MINUS_FALLBACK);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'dsh-mermaid-camera-button';
  resetBtn.setAttribute('aria-label', t('resetView'));
  resetBtn.setAttribute('data-dsh-mermaid-action', 'reset');
  resetBtn.innerHTML = spriteIcon('dsw-icon-refresh-outline-regular', RESET_FALLBACK);
  const controls = document.createElement('div');
  controls.className = 'dsh-mermaid-camera-controls';
  controls.append(zoomIn, zoomOut, resetBtn);

  stage.append(svg, controls);
  body.appendChild(stage);
  panel.append(head, body);
  overlay.append(panel);

  let camera = null;
  const previousFocus = document.activeElement;
  const previousOverflow = document.body.style.overflow;

  const applyState = (state) => {
    if (state === null) return;
    const disableOut = state.scale <= state.least * 1.001;
    const disableIn = state.scale >= state.most * 0.999;
    if (zoomOut.disabled !== disableOut) zoomOut.disabled = disableOut;
    if (zoomIn.disabled !== disableIn) zoomIn.disabled = disableIn;
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };
  const dismiss = () => {
    try {
      camera?.destroy();
    } catch (error) {
      console.warn('[dsh-mermaid] 相机清理失败', error);
    }
    overlay.remove();
    if (document.body.style.overflow !== previousOverflow) document.body.style.overflow = previousOverflow;
    document.removeEventListener('keydown', onKeyDown, true);
    if (closeLightbox === dismiss) closeLightbox = null;
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  };

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) dismiss();
  });
  close.addEventListener('click', dismiss);
  zoomIn.addEventListener('click', () => camera?.zoomBy(1.35));
  zoomOut.addEventListener('click', () => camera?.zoomBy(1 / 1.35));
  resetBtn.addEventListener('click', () => camera?.settle());

  document.addEventListener('keydown', onKeyDown, true);
  document.body.style.overflow = 'hidden';
  document.body.append(overlay);
  closeLightbox = dismiss;

  try {
    camera = createCamera(stage, svg, applyState);
    camera?.settle(); // 初始：整图 contain 居中
  } catch (error) {
    console.warn('[dsh-mermaid] 相机初始化失败', error);
  }

  stage.focus({ preventScroll: true });
}

function onClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const button = target.closest(`[${ATTR_TOGGLE}]`);
  if (button !== null) {
    const block = button.closest(BLOCK);
    if (block === null) return;
    event.preventDefault();
    event.stopPropagation();
    block.dataset[DS_STATE] = stateOf(block) === 'source' ? 'diagram' : 'source';
    sync(block);
    return;
  }

  // 点击图本身 = 打开大图预览（和聊天里的图片一致）
  const figure = target.closest(`[${ATTR_FIG}]`);
  if (figure === null || target.closest('button') !== null) return;
  const block = figure.closest(BLOCK);
  if (block === null || stateOf(block) === 'source') return;
  event.preventDefault();
  openLightbox(block);
}

/**
 * 处理一个 mermaid 代码块。
 * @returns {'ok'|'grace'|'error'|'same'|'skip'}
 */
function processBlock(block, now) {
  const pre = block.querySelector(`${CONTENT} > pre`);
  if (pre === null) return 'skip';
  const source = sourceOf(pre).trim();
  if (source === '') return 'skip';
  if (!isPlainCode(pre)) return 'skip';            // 已被高亮的语言（ts/bash/json…）不处理
  const mermaidType = detectMermaid(source);
  if (mermaidType === null) return 'skip';          // 不像 mermaid 的普通代码块不处理

  const lines = source.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2 && mermaidType !== 'info') return 'skip'; // 流式中的空图（如单独一行 flowchart LR）

  const state = stateFor(block, now);
  const hash = hashOf(source);
  if (state.hash !== hash) {
    state.hash = hash;
    state.changedAt = now;
    state.error = undefined;
  }
  if (block.dataset[DS_HASH] !== hash) block.dataset[DS_HASH] = hash;
  if (!block.hasAttribute('data-dsh-mermaid-enabled')) block.setAttribute('data-dsh-mermaid-enabled', '');

  // 已经渲染过同一份源码：只同步显隐，不重渲染
  if (state.error === undefined && state.hasFigure && state.renderedHash === hash) {
    const figure = block.querySelector(`[${ATTR_FIG}]`);
    if (figure !== null) {
      sync(block);
      return 'same';
    }
  }

  if (state.error !== undefined) {
    if (now - state.changedAt < ERROR_GRACE_MS) return 'grace';
    // 用户主动切到源码态时不要把他拽回错误视图；只在图态显示错误面板
    if (stateOf(block) === 'source') {
      sync(block);
      return 'error';
    }
    showError(block, pre, state.error);
    return 'error';
  }

  const result = renderSafely(source, 0);
  if (result.ok && (result.width < 40 || result.height < 24)) return 'skip'; // 退化空图，等真正的内容
  if (!result.ok) {
    state.error = result;
    state.hasFigure = false;
    if (now - state.changedAt < ERROR_GRACE_MS) return 'grace';
    showError(block, pre, result);
    return 'error';
  }

  state.hasFigure = true;
  state.type = result.type;
  state.renderedHash = hash;
  renderInto(block, pre, state, result);
  return 'ok';
}

function insertFallbackStyle(css) {
  const el = document.createElement('style');
  el.setAttribute('data-dsh-mermaid', '');
  el.textContent = css;
  document.head.append(el);
  return () => el.remove();
}


/**
 * 语言切换：DSH 的 locale 服务会把当前语言写回 <html lang>，监听它即可实时换词，
 * 不需要依赖 DSH 内部模块。已经增强过的块、错误面板和打开中的预览都会刷新。
 */
function relanguage() {
  for (const block of document.querySelectorAll(BLOCK)) {
    if (!(block instanceof HTMLElement) || !block.hasAttribute('data-dsh-mermaid-enabled')) continue;
    const state = blockState.get(block);
    const pre = block.querySelector(`${CONTENT} > pre`);
    const isError = state !== undefined && state.error !== undefined && pre !== null;
    if (isError) showError(block, pre, state.error); // 重建错误面板（位置/原因文案随语言变）
    const figure = block.querySelector(`[${ATTR_FIG}]`);
    if (!isError && figure !== null && state !== undefined) {
      const label = t('figureLabel', state.width ?? 0);
      if (figure.getAttribute('aria-label') !== label) figure.setAttribute('aria-label', label);
    }
    const zoom = block.querySelector(`[${ATTR_ZOOM}]`);
    if (zoom !== null && zoom.getAttribute('aria-label') !== t('zoom')) zoom.setAttribute('aria-label', t('zoom'));
    const copy = block.querySelector(`[${ATTR_IMAGE_COPY}]`);
    if (copy !== null && copy.dataset.busy !== 'true' && copy.getAttribute('aria-label') !== t('copyImage')) {
      copy.setAttribute('aria-label', t('copyImage'));
    }
    sync(block);
  }

  const overlay = document.querySelector('.dsh-mermaid-lightbox');
  if (overlay === null) return;
  overlay.setAttribute('aria-label', t('preview'));
  overlay.querySelector('.dsh-mermaid-lightbox-close')?.setAttribute('aria-label', t('previewClose'));
  overlay.querySelector('.dsh-mermaid-zoom-stage')?.setAttribute('aria-label', t('canvas'));
  const labels = { in: t('zoomIn'), out: t('zoomOut'), reset: t('resetView') };
  for (const button of overlay.querySelectorAll('[data-dsh-mermaid-action]')) {
    const action = button.getAttribute('data-dsh-mermaid-action');
    if (action !== null && labels[action] !== undefined) button.setAttribute('aria-label', labels[action]);
  }
}

window.__ModuleLoader__.load({
  id: PKG_ID,
  factory() {
    return {
      apply(ctx) {
        ctx.effect(() => {
          const disposeStyles =
            typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function'
              ? styles.insert(CSS)
              : insertFallbackStyle(CSS);

          let debounceTimer = 0;
          let recheckTimer = 0;

          const flush = () => {
            debounceTimer = 0;
            const now = Date.now();
            let grace = false;
            for (const block of document.querySelectorAll(BLOCK)) {
              if (!(block instanceof HTMLElement)) continue;
              try {
                if (processBlock(block, now) === 'grace') grace = true;
              } catch (error) {
                console.error('[dsh-mermaid] 处理代码块失败', error);
              }
            }
            if (grace && recheckTimer === 0) {
              recheckTimer = window.setTimeout(() => {
                recheckTimer = 0;
                flush();
              }, ERROR_GRACE_MS + 100);
            }
          };

          const schedule = () => {
            if (debounceTimer !== 0) return;
            debounceTimer = window.setTimeout(flush, DEBOUNCE_MS);
          };

          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === 'characterData') {
                const el = record.target.parentElement;
                if (el !== null && el.closest(BLOCK) !== null) {
                  schedule();
                  return;
                }
                continue;
              }
              if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
                schedule();
                return;
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });

          // 语言切换：只认 <html lang>（DSH locale 服务会维护它）
          const languageObserver = new MutationObserver(() => relanguage());
          languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
          document.addEventListener('click', onClick, true);

          document.documentElement.setAttribute('data-dsh-mermaid', 'ready');
          console.info('[dsh-mermaid] active');
          flush(); // 插件激活时页面上可能已有历史消息

          return () => {
            observer.disconnect();
            languageObserver.disconnect();
            document.removeEventListener('click', onClick, true);
            if (debounceTimer !== 0) window.clearTimeout(debounceTimer);
            if (recheckTimer !== 0) window.clearTimeout(recheckTimer);
            closeLightbox?.();
            disposeTooltips();
            document.documentElement.removeAttribute('data-dsh-mermaid');
            disposeStyles();
          };
        });
      },
    };
  },
});
