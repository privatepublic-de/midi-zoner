module.exports = {
  /**
   * Returns first matching element for selector string or selector itself if it's no string.
   * @param {*} selector
   */
  element: function(selector) {
    if (typeof selector === 'string') {
      return document.querySelector(selector);
    } else {
      return selector;
    }
  },
  /**
   * Find elements within rootElement. Applies optional handler function for each element.
   * @param {object} rootElement
   * @param {string} selector
   * @param {function} handler
   */
  find: function(rootElement, selector, handler) {
    const list = rootElement.querySelectorAll(selector);
    if (handler) {
      for (let i = 0; i < list.length; i++) {
        handler(list[i]);
      }
    }
    return list;
  },
  /**
   * Returns list of all elements matching selector. Applies optional handler function for each element.
   * @param {*} selector
   * @param {function} handler
   */
  all: function(selector, handler) {
    let list = [];
    if (selector) {
      if (typeof selector === 'string') {
        list = document.querySelectorAll(selector);
      } else if (selector.tagName) {
        list = [selector];
      } else {
        list = selector.length ? Array.from(selector) : [selector];
      }
    }
    if (handler) {
      for (let i = 0; i < list.length; i++) {
        handler(list[i]);
      }
    }
    return list;
  },
  /**
   * Attaches event listener function to all elements matching selector.
   * @param {*} selector
   * @param {string} eventName
   * @param {function} handler
   */
  on: function(selector, eventName, handler) {
    DOM.all(selector, function(el) {
      el.addEventListener(eventName, handler);
    });
  },
  /**
   * Attaches event listener function to all elements matching selector only within rootElement.
   * @param {object} rootElement
   * @param {string} selector
   * @param {string} eventName
   * @param {function} handler
   */
  attachInside: function(rootElement, selector, eventName, handler) {
    DOM.find(rootElement, selector, function(el) {
      DOM.on(el, eventName, handler);
    });
  },
  /**
   * Clears content of all elements matching selector.
   * @param {*} selector
   */
  empty: function(selector) {
    DOM.all(selector, function(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    });
  },
  /**
   * Sets style.display = 'none' for all matching elements.
   * @param {*} selector
   */
  hide: function(selector) {
    DOM.all(selector, function(el) {
      el.style.display = 'none';
    });
  },
  /**
   * Sets style.display = 'block' for all matching elements.
   * @param {*} selector
   */
  show: function(selector) {
    DOM.all(selector, function(el) {
      el.style.display = 'block';
    });
  },
  /**
   * Removes style class 'visible' from all matching elements.
   * @param {*} selector
   */
  unvisible: function(selector) {
    DOM.removeClass(selector, 'visible');
  },
  /**
   * Adds style class 'visible' to all matching elements.
   * @param {*} selector
   */
  visible: function(selector) {
    DOM.addClass(selector, 'visible');
  },
  /**
   * Adds style class to all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  addClass: function(selector, className) {
    DOM.all(selector, function(el) {
      el.classList.add(className);
    });
  },
  /**
   * Removes style class from all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  removeClass: function(selector, className) {
    if (className) {
      DOM.all(selector, function(el) {
        el.classList.remove(className);
      });
    } else {
      DOM.all(selector, function(el) {
        el.className = '';
      });
    }
  },
  /**
   * Adds HTML to matching element at given position.
   * @param {*} selector
   * @param {string} position ['beforebegin', 'afterbegin', 'beforeend', 'afterend']
   * @param {string} html
   */
  addHTML: function(selector, position, html) {
    let element = DOM.element(selector);
    element.insertAdjacentHTML(position, html);
    return element;
  },
  /**
   * Returns attribute value of first element in parent chain containing this attribute.
   * @param {object} el
   * @param {string} attrname
   */
  ancestorAttribute: function(el, attrname) {
    let element = el;
    let attrValue = null;
    while (element && !(attrValue = element.getAttribute(attrname))) {
      element = element.parentElement;
    }
    return attrValue;
  },

  hslToRgb: function(h, s, l) {
    var r, g, b;

    if (s == 0) {
      r = g = b = l; // achromatic
    } else {
      var hue2rgb = function hue2rgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
};
