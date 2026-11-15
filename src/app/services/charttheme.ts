/**
 * Chart colours for the Terminal design, read from the CSS tokens in main.css
 * so lightweight-charts and the SVG charts follow the theme (dark or light).
 * Read at chart-build time; a theme switch rebuilds the charts anyway.
 */
const ChartTheme = (() => {
  const DARK_PALETTE = ['#C6F432', '#9FB0B8', '#3DDC97', '#F2C94C', '#7AA2F7',
                        '#FF8FA3', '#B9A3FF', '#FF9F5B', '#5CD6E0', '#A3B86C'];
  const LIGHT_PALETTE = ['#4D7C0F', '#52606A', '#15803D', '#A16207', '#1D4ED8',
                         '#BE185D', '#6D28D9', '#C2410C', '#0E7490', '#65751F'];

  function isDark(): boolean {
    return !document.body.classList.contains('theme-light');
  }

  function token(name: string, fallback: string): string {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** '#RRGGBB' + alpha 0..1 -> 'rgba(r,g,b,a)'. Non-hex input comes back unchanged. */
  function alpha(hex: string, a: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function get() {
    const dark = isDark();
    const accent = token('--accent-cyan', dark ? '#C6F432' : '#4D7C0F');
    return {
      dark,
      accent,
      accentInk: token('--accent-ink', dark ? '#0B0D0E' : '#FFFFFF'),
      areaTop: alpha(accent, dark ? 0.16 : 0.14),
      areaBottom: alpha(accent, 0),
      crosshair: alpha(accent, 0.45),
      pos: token('--pos', dark ? '#3DDC97' : '#15803D'),
      neg: token('--neg', dark ? '#FF6B5B' : '#B91C1C'),
      grid: dark ? 'rgba(139, 145, 150, 0.08)' : 'rgba(0, 0, 0, 0.06)',
      border: dark ? 'rgba(139, 145, 150, 0.18)' : 'rgba(0, 0, 0, 0.12)',
      text: token('--text-muted', dark ? '#8B9196' : '#59615F'),
      muted: token('--text-dimmer', dark ? '#4A5257' : '#AEB4B0'),
      font: "'JetBrains Mono', Consolas, monospace",
      palette: dark ? DARK_PALETTE : LIGHT_PALETTE,
    };
  }

  return { get, alpha };
})();
