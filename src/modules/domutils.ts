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
  addClass,
  removeClass,
  switchClass,
  addHTML,
  clientOffsets
};

export default DOM;
