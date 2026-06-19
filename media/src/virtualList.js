// Thin vanilla driver around @tanstack/virtual-core. This is the ONLY file that
// touches the virtualizer API, so any library drift is contained here. See
// TanStack/virtual#455: in non-framework use you must supply the exported
// observeElementRect / observeElementOffset and kick the first computation.
import { Virtualizer, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.scrollEl  scroll container (overflow:auto; position:relative)
 * @param {() => number} opts.getCount  current item count
 * @param {(index: number) => string|number} opts.getKey  stable key for item index
 * @param {(index: number) => HTMLElement} opts.renderRow  build the DOM node for an index
 * @param {() => number} [opts.estimateSize]  estimated row height (default 56)
 * @param {number} [opts.overscan]  default 6
 */
export function createVirtualList(opts) {
  const { scrollEl, getCount, getKey, renderRow, estimateSize = () => 56, overscan = 6 } = opts;
  const inner = document.createElement('div');
  inner.style.position = 'relative';
  inner.style.width = '100%';
  scrollEl.appendChild(inner);

  const mounted = new Map(); // key -> HTMLElement

  const virtualizer = new Virtualizer({
    count: getCount(),
    getScrollElement: () => scrollEl,
    estimateSize,
    overscan,
    getItemKey: getKey,
    observeElementRect,
    observeElementOffset,
    onChange: () => repaint(),
  });
  // Vanilla kickoff (maintainer-confirmed recipe). Guarded so a future rename
  // is a no-op rather than a crash; the observer-driven onChange is the backup.
  if (typeof virtualizer._willUpdate === 'function') virtualizer._willUpdate();

  function repaint() {
    const items = virtualizer.getVirtualItems();
    inner.style.height = virtualizer.getTotalSize() + 'px';
    const seen = new Set();
    for (const it of items) {
      const key = getKey(it.index);
      seen.add(key);
      let el = mounted.get(key);
      if (!el) {
        el = renderRow(it.index);
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.width = '100%';
        el.setAttribute('data-index', String(it.index));
        mounted.set(key, el);
        inner.appendChild(el);
      }
      el.style.transform = `translateY(${it.start}px)`;
      virtualizer.measureElement(el); // dynamic height (expanded rows are taller)
    }
    for (const [key, el] of mounted) {
      if (!seen.has(key)) { el.remove(); mounted.delete(key); }
    }
  }

  /** Count changed (filter / roster reset): recreate the instance cleanly to
   *  avoid mutating the readonly options object. Preserves scroll offset. */
  function setCount() {
    const offset = scrollEl.scrollTop;
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    virtualizer.options.count = getCount();
    if (typeof virtualizer._willUpdate === 'function') virtualizer._willUpdate();
    scrollEl.scrollTop = offset;
    repaint();
  }

  function scrollToIndex(index) { virtualizer.scrollToIndex(index); }

  function destroy() {
    for (const el of mounted.values()) el.remove();
    mounted.clear();
    inner.remove();
  }

  repaint();
  return { repaint, setCount, scrollToIndex, destroy };
}
