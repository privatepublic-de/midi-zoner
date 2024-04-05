module.exports = {
  /**
   * Returns first matching element for selector string or selector itself if it's no string.
   * @param {*} selector
   */
  element: function (selector) {
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
  find: function (rootElement, selector, handler) {
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
  all: function (selector, handler) {
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
  on: function (selector, eventName, handler) {
    DOM.all(selector, function (el) {
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
  attachInside: function (rootElement, selector, eventName, handler) {
    DOM.find(rootElement, selector, function (el) {
      DOM.on(el, eventName, handler);
    });
  },
  /**
   * Clears content of all elements matching selector.
   * @param {*} selector
   */
  empty: function (selector) {
    DOM.all(selector, function (el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    });
  },
  /**
   * Sets style.display = 'none' for all matching elements.
   * @param {*} selector
   */
  hide: function (selector) {
    DOM.all(selector, function (el) {
      el.style.display = 'none';
    });
  },
  /**
   * Sets style.display = 'block' for all matching elements.
   * @param {*} selector
   */
  show: function (selector) {
    DOM.all(selector, function (el) {
      el.style.display = 'block';
    });
  },
  /**
   * Removes style class 'visible' from all matching elements.
   * @param {*} selector
   */
  unvisible: function (selector) {
    DOM.removeClass(selector, 'visible');
  },
  /**
   * Adds style class 'visible' to all matching elements.
   * @param {*} selector
   */
  visible: function (selector) {
    DOM.addClass(selector, 'visible');
  },
  /**
   * Adds style class to all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  addClass: function (selector, className) {
    DOM.all(selector, function (el) {
      el.classList.add(className);
    });
  },
  /**
   * Removes style class from all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  removeClass: function (selector, className) {
    if (className) {
      DOM.all(selector, function (el) {
        el.classList.remove(className);
      });
    } else {
      DOM.all(selector, function (el) {
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
  addHTML: function (selector, position, html) {
    let element = DOM.element(selector);
    element.insertAdjacentHTML(position, html);
    return element;
  },
  /**
   * Returns attribute value of first element in parent chain containing this attribute.
   * @param {object} el
   * @param {string} attrname
   */
  ancestorAttribute: function (el, attrname) {
    let element = el;
    let attrValue = null;
    while (element && !(attrValue = element.getAttribute(attrname))) {
      element = element.parentElement;
    }
    return attrValue;
  },
  /* TODO Document */
  clientOffsets: function (el) {
    const rect = el.getBoundingClientRect();
    return { offsetTop: rect.y, offsetLeft: rect.x };
  },
  /* TODO Document */
  scaledCanvasContext: function (canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    // Set the "actual" size of the canvas
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    // Scale the context to ensure correct drawing operations
    ctx.scale(dpr, dpr);
    // Set the "drawn" size of the canvas
    // canvas.style.width = `${rect.width}px`;
    // canvas.style.height = `${rect.height}px`;
    return { context: ctx, rect: rect };
  },
  /**
   * Convert hsl values (0-1) to rgb.
   * @param {number} h Hue
   * @param {number} s Saturation
   * @param {number} l Luminosity
   * @returns {Number[]} [r,g,b] values (0-255)
   */
  hslToRgb: function (h, s, l) {
    let r, g, b;

    if (s == 0) {
      r = g = b = l; // achromatic
    } else {
      let hue2rgb = function hue2rgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      let p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  },

  /**
   * Convert rgb values to hex color string (#ffffff)
   * @param {number[]} rgb [r,g,b] values (0-255)
   * @returns {string} corresponding hex color value
   */
  rgbToHex: function (rgb) {
    const toHex = function (v) {
      let hex = Number(Math.floor(v)).toString(16);
      if (hex.length < 2) {
        hex = '0' + hex;
      }
      return hex;
    };
    return '#' + toHex(rgb[0]) + toHex(rgb[1]) + toHex(rgb[2]);
  },

  /**
   * Calculate [hue, saturation, luminosity] out of three rgb values (0-255)
   * @param {Number[]} rgbArr [r,g,b] (0-255)
   * @returns {Number[]} [h,s,l] values (0-1)
   */
  rgb2hsl: function (rgbArr) {
    let r = rgbArr[0] / 255,
      g = rgbArr[1] / 255,
      b = rgbArr[2] / 255;

    let max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    let h,
      s,
      l = (max + min) / 2;

    if (max == min) {
      h = s = 0;
    } else {
      let d = max - min;
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
  },

  /**
   * RGB value array from hex color string (#ffffff)
   * @param {string} hex hex color string
   * @returns {Number[]} [r,g,b] values
   */
  hexToRgb(hex) {
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
};
