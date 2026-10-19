/**
 * DOM helpers. Everything here writes text through textContent/text nodes and
 * never uses innerHTML, so report content can never become markup.
 *
 * Deliberately no `style` support: the harness CSP allows stylesheets only, so
 * views style themselves with classes and static CSS files.
 */

export function node(tag, text = '', className = '') {
  const element = document.createElement(tag);
  if (text !== '' && text !== null && text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function text(value) {
  return document.createTextNode(String(value ?? ''));
}

export function append(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, ...child);
    } else if (child instanceof Node) {
      parent.append(child);
    } else {
      parent.append(document.createTextNode(String(child)));
    }
  }
  return parent;
}

export function clear(element) {
  element.replaceChildren();
  return element;
}

/**
 * Create an element with properties, attributes, event handlers and children.
 *
 *   el('button', { className: 'primary', type: 'button', on: { click: run } }, 'Run')
 *   el('input', { attrs: { 'aria-label': 'Search' }, value: '' })
 *
 * Unknown keys become attributes; known DOM properties are assigned directly.
 */
export function el(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        if (typeof handler === 'function') element.addEventListener(event, handler);
      }
    } else if (key === 'attrs') {
      for (const [name, attr] of Object.entries(value)) {
        if (attr === false || attr === null || attr === undefined) continue;
        element.setAttribute(name, attr === true ? '' : String(attr));
      }
    } else if (key in element) {
      element[key] = value;
    } else {
      element.setAttribute(key, String(value));
    }
  }
  append(element, ...children);
  return element;
}

/** SVG variant of el(); SVG nodes require createElementNS. */
export function svg(tag, attrs = {}, ...children) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      for (const item of child) if (item instanceof Node) element.append(item);
    } else if (child instanceof Node) {
      element.append(child);
    } else {
      element.append(document.createTextNode(String(child)));
    }
  }
  return element;
}

export function emptyBlock(title, message, glyph = '◎') {
  const block = el('div', { className: 'empty-state' });
  block.append(
    el('span', { text: glyph, attrs: { 'aria-hidden': 'true' } }),
    el('h3', { text: title }),
    el('p', { text: message }),
  );
  return block;
}

export function emptyState(container, title, message, glyph = '◎') {
  container.replaceChildren(emptyBlock(title, message, glyph));
  return container;
}
