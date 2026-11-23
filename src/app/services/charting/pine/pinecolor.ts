/*
 * Pine Script colours. A colour is { r, g, b, t } where t is Pine's
 * transparency (0 = opaque, 100 = invisible). `na` colours are NaN or null.
 */

interface PineColor { r: number; g: number; b: number; t: number; }

const PineColors = (() => {
  function isColor(v: any): v is PineColor {
    return !!v && typeof v === 'object' && typeof v.r === 'number' && typeof v.t === 'number';
  }

  /** #RRGGBB or #RRGGBBAA (AA is alpha, so 00 is fully transparent). */
  function hex(h: string): PineColor | null {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const a = m[2] != null ? parseInt(m[2], 16) : 255;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, t: Math.round((1 - a / 255) * 10000) / 100 };
  }

  function clampByte(v: number): number {
    return Math.max(0, Math.min(255, Math.round(isFinite(v) ? v : 0)));
  }

  function rgb(r: number, g: number, b: number, t = 0): PineColor {
    return { r: clampByte(r), g: clampByte(g), b: clampByte(b), t: Math.max(0, Math.min(100, isFinite(t) ? t : 0)) };
  }

  /** CSS for a colour, or null for na. */
  function css(c: any): string | null {
    if (!isColor(c)) return null;
    const cached = (c as any).__css;
    if (cached) return cached;
    const a = Math.round((1 - c.t / 100) * 1000) / 1000;
    const s = `rgba(${c.r},${c.g},${c.b},${a})`;
    // Non-enumerable, so { ...c, t } copies don't inherit a stale string.
    Object.defineProperty(c, '__css', { value: s, enumerable: false });
    return s;
  }

  /** "#RRGGBB" for colour pickers (drops transparency). */
  function toHex(c: PineColor): string {
    return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /** Parse what a colour setting holds: "#RRGGBB[AA]" or "rgba(...)". */
  function parse(s: string): PineColor | null {
    if (typeof s !== 'string') return null;
    const h = hex(s);
    if (h) return h;
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s.trim());
    if (!m) return null;
    const a = m[4] != null ? Number(m[4]) : 1;
    return rgb(Number(m[1]), Number(m[2]), Number(m[3]), (1 - a) * 100);
  }

  /** Pine's named colours. v6 retuned a few of them. */
  const BASE: Record<string, string> = {
    aqua: '#00BCD4', black: '#363A45', blue: '#2196F3', fuchsia: '#E040FB', gray: '#787B86',
    green: '#4CAF50', lime: '#00E676', maroon: '#880E4F', navy: '#311B92', olive: '#808000',
    orange: '#FF9800', purple: '#9C27B0', red: '#FF5252', silver: '#B2B5BE', teal: '#00897B',
    white: '#FFFFFF', yellow: '#FFEB3B',
  };
  const V6: Record<string, string> = { red: '#F23645', teal: '#089981', yellow: '#FDD835' };

  function named(name: string, version: number): PineColor | null {
    const h = (version >= 6 && V6[name]) || BASE[name];
    return h ? hex(h) : null;
  }

  const NAMES = Object.keys(BASE);

  return { isColor, hex, rgb, css, toHex, parse, named, NAMES };
})();
