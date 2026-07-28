/**
 * Repaint — forces Chromium to redraw a subtree we just replaced.
 *
 * On Windows, Electron sometimes leaves freshly-inserted rows unpainted: the
 * DOM is there and takes up space, but the region isn't redrawn until some
 * unrelated invalidation happens — which is why hovering a row (and triggering
 * its :hover background) appears to "fix" it.
 *
 * Reading a layout property flushes pending layout; toggling a property that
 * forces a new paint — and clearing it on the next frame — makes the compositor
 * mark the region dirty. Cheap, and a no-op when the paint was already correct.
 */
const Repaint = (() => {

  function nudge(el: HTMLElement | null): void {
    if (!el) return;

    // Flush layout so the new rows have boxes before we invalidate.
    void el.offsetHeight;

    // An imperceptible opacity change the compositor cannot skip, reverted on
    // the next frame so nothing is left behind on the element.
    const previous = el.style.opacity;
    el.style.opacity = '0.9999';
    requestAnimationFrame(() => {
      el.style.opacity = previous;
    });
  }

  /** Convenience for the common case of "I just set innerHTML on this table". */
  function nudgeTable(tbodyId: string): void {
    const tbody = document.getElementById(tbodyId);
    nudge(tbody?.closest('table') as HTMLElement | null);
  }

  return { nudge, nudgeTable };
})();
