type SelectorType = string | Element | NodeList | HTMLElement | Document | Element[] | null;
type ElementHandler = (el: Element) => void;

interface ClientOffsets {
  offsetTop: number;
  offsetLeft: number;
  offsetWidth: number;
  offsetHeight: number;
}

/**
 * Returns first matching element for selector string or selector itself if it's no string.
 */
function get(selector: SelectorType): Element | null {
  if (typeof selector === 'string') {
    return document.querySelector(selector);
  } else {
    return selector as Element | null;
  }
}

/**
 * Find elements within rootElement. Applies optional handler function for each element.
 */
function find(
  rootElement: Element,
  selector: string,
  handler?: ElementHandler
): NodeListOf<Element> {
  const list = rootElement.querySelectorAll(selector);
  if (handler) {
    for (let i = 0; i < list.length; i++) {
      handler(list[i]);
    }
  }
  return list;
}

/**
 * Returns list of all elements matching selector. Applies optional handler function for each element.
 */
function all(selector: SelectorType, handler?: ElementHandler): Element[] {
  let list: Element[] = [];
  if (selector) {
    if (typeof selector === 'string') {
      list = Array.from(document.querySelectorAll(selector));
    } else if ((selector as Element).tagName) {
      list = [selector as Element];
    } else {
      list = (selector as NodeList).length
        ? Array.from(selector as NodeList) as Element[]
        : [selector as Element];
    }
  }
  if (handler) {
    for (let i = 0; i < list.length; i++) {
      handler(list[i]);
    }
  }
  return list;
}

/**
 * Attaches event listener function to all elements matching selector.
 */
function on(
  selector: SelectorType,
  eventName: string,
  handler: EventListener
): void {
  all(selector, function (el) {
    el.addEventListener(eventName, handler);
  });
}

/**
 * Attaches event listener function to all elements matching selector only within rootElement.
 */
function attachInside(
  rootElement: Element,
  selector: string,
  eventName: string,
  handler: EventListener
): void {
  find(rootElement, selector, function (el) {
    on(el, eventName, handler);
  });
}

/**
 * Clears content of all elements matching selector.
 */
function empty(selector: SelectorType): void {
  all(selector, function (el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  });
}

/**
 * Sets style.display = 'none' for all matching elements.
 */
function hide(selector: SelectorType): void {
  all(selector, function (el) {
    (el as HTMLElement).style.display = 'none';
  });
}

/**
 * Sets style.display = 'block' for all matching elements.
 */
function show(selector: SelectorType): void {
  all(selector, function (el) {
    (el as HTMLElement).style.display = 'block';
  });
}

/**
 * Removes style class 'visible' from all matching elements.
 */
function unvisible(selector: SelectorType): void {
  removeClass(selector, 'visible');
}

/**
 * Adds style class 'visible' to all matching elements.
 */
function visible(selector: SelectorType): void {
  addClass(selector, 'visible');
}

/**
 * Adds style class to all matching elements.
 */
function addClass(selector: SelectorType, ...classNames: string[]): void {
  all(selector, function (el) {
    el.classList.add(...classNames);
  });
}

/**
 * Removes style class from all matching elements.
 */
function removeClass(selector: SelectorType, ...classNames: string[]): void {
  if (classNames.length > 0) {
    all(selector, function (el) {
      el.classList.remove(...classNames);
    });
  } else {
    all(selector, function (el) {
      el.className = '';
    });
  }
}

/**
 * Switches style classes on (enabled) or off for all matching elements.
 */
function switchClass(
  selector: SelectorType,
  enabled: boolean,
  ...classNames: string[]
): void {
  if (enabled) {
    addClass(selector, ...classNames);
  } else {
    removeClass(selector, ...classNames);
  }
}

/**
 * Adds HTML to matching element at given position.
 */
function addHTML(
  selector: SelectorType,
  position: InsertPosition,
  html: string
): Element | null {
  const element = get(selector);
  if (element) {
    element.insertAdjacentHTML(position, html);
  }
  return element;
}

/**
 * Returns attribute value of first element in parent chain containing this attribute.
 */
function ancestorAttribute(el: Element | null, attrname: string): string | null {
  let element: Element | null = el;
  let attrValue: string | null = null;
  while (element && !(attrValue = element.getAttribute(attrname))) {
    element = element.parentElement;
  }
  return attrValue;
}

/**
 * Get client offsets for an element.
 */
function clientOffsets(el: Element): ClientOffsets {
  const rect = el.getBoundingClientRect();
  return {
    offsetTop: rect.y,
    offsetLeft: rect.x,
    offsetWidth: rect.width,
    offsetHeight: rect.height
  };
}

/**
 * Convert hsl values (0-1) to rgb.
 * @param h Hue
 * @param s Saturation
 * @param l Luminosity
 * @returns [r,g,b] values (0-255)
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = function (p: number, q: number, t: number): number {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Convert rgb values to hex color string (#ffffff)
 * @param rgb [r,g,b] values (0-255)
 * @returns corresponding hex color value
 */
function rgbToHex(rgb: [number, number, number]): string {
  const toHex = function (v: number): string {
    let hex = Number(Math.floor(v)).toString(16);
    if (hex.length < 2) {
      hex = '0' + hex;
    }
    return hex;
  };
  return '#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
}

/**
 * Calculate [hue, saturation, luminosity] out of three rgb values (0-255)
 * @param rgbArr [r,g,b] (0-255)
 * @returns [h,s,l] values (0-1)
 */
function rgb2hsl(rgbArr: [number, number, number]): [number, number, number] {
  const r = rgbArr[0] / 255,
    g = rgbArr[1] / 255,
    b = rgbArr[2] / 255;

  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h: number = 0,
    s: number;
  const l = (max + min) / 2;

  if (max == min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }

    h /= 6;
  }

  return [h, s, l];
}

/**
 * RGB value array from hex color string (#ffffff)
 * @param hex hex color string
 * @returns [r,g,b] values
 */
function hexToRgb(hex: string): [number, number, number] {
  if (hex.length < 6 || hex.length > 7) {
    throw new Error('Hex color syntax error: ' + hex);
  }
  if (hex.indexOf('#') === 0) {
    hex = hex.substr(1);
  }
  return [
    parseInt(hex.substr(0, 2), 16),
    parseInt(hex.substr(2, 2), 16),
    parseInt(hex.substr(4, 2), 16)
  ];
}

// Export as a single object for backwards compatibility
const DOM = {
  get,
  find,
  all,
  on,
  attachInside,
  empty,
  hide,
  show,
  unvisible,
  visible,
  addClass,
  removeClass,
  switchClass,
  addHTML,
  ancestorAttribute,
  clientOffsets,
  hslToRgb,
  rgbToHex,
  rgb2hsl,
  hexToRgb
};

export = DOM;
