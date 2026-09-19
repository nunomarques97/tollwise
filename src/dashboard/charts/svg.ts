// A small SVG element builder, the DOM-facing half of the chart helper (the scale/layout/model math in
// ./scale.ts, ./layout.ts, ./timeseries-model.ts and ./breakdown-model.ts is pure and tested separately).
// Every attribute is set through setAttribute/setAttributeNS -- never a style attribute (the page's CSP
// forbids inline styles) -- so colours come only from CSS classes (DESIGN.md §12: fill/stroke via
// `.chart-save { fill: var(--positive); }`, never written into HTML).

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;
type Child = SVGElement | string | undefined | false;

/** Creates one namespaced SVG element with the given attributes and children. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** An SVG `<text>` node; `anchor` defaults to the SVG default ("start"). */
export function svgText(x: number, y: number, content: string, anchor?: 'start' | 'middle' | 'end'): SVGTextElement {
  const element = svgEl('text', { x, y, 'text-anchor': anchor });
  element.textContent = content;
  return element;
}

/**
 * Defines the diagonal-hatch fill pattern used for "savings unknown" bands (DESIGN.md §12.4), scoped to
 * `id` so two charts on the same page never share (or collide over) one pattern definition.
 */
export function hatchPattern(id: string): SVGDefsElement {
  const line = svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'chart-hatch-line' });
  const pattern = svgEl(
    'pattern',
    { id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    [line],
  );
  return svgEl('defs', {}, [pattern]);
}
