// A small helper to build elements without innerHTML: every value from the API is set as text, never
// parsed as markup. The page's Content-Security-Policy forbids inline styles, so no helper here takes a
// style; dynamic sizes are set through element.style by the caller.

import type { TextRun } from './overview-model.ts';

type Attributes = Readonly<Record<string, string | boolean | undefined>>;
type Child = Node | string | undefined | false;

/** Creates `<tag>` with the given attributes (true: present and empty; false or undefined: absent). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** Text runs as nodes: strong runs in <b>, the rest as plain text. */
export function runs(parts: readonly TextRun[]): Node[] {
  return parts.map((part) => (part.strong === true ? h('b', {}, [part.text]) : document.createTextNode(part.text)));
}

/** Replaces every child of `parent` with `children`. */
export function replaceChildren(parent: Element, children: readonly Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => child !== undefined && child !== false));
}

/** True when the user asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
