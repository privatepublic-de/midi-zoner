const DOM = require('./domutils');

class PotDragHandler {
  isDragging = false;
  cx = 0;
  cy = 0;
  /** @type {function} */ updateValueCallback = null;
  /** @type {function} */ finishedCallback = null;
  constructor() {
    window.addEventListener('mousemove', this.move.bind(this));
    window.addEventListener('mouseup', this.stopDrag.bind(this));
  }

  valueForCoordinates(x, y) {
    const y0 = y - this.cy;
    const x0 = x - this.cx;
    let ang = parseInt(Math.atan2(y0, x0) * (180 / Math.PI));
    if (ang < 0 && ang >= -90) {
      ang += 225;
    } else if (ang >= 0 && ang < 45) {
      ang += 225;
    } else if (ang < -90) {
      ang += 225;
    } else if (ang > 135) {
      ang -= 135;
    } else {
      if (ang < 90) {
        ang = 270;
      } else {
        ang = 0;
      }
    }
    return Math.floor((ang / 270.0) * 127);
  }

  startDrag(
    /** @type {HTMLElement} */ pot,
    /** @type {MouseEvent} */ e,
    /** @type {function} */ updateValueCallback,
    /** @type {function} */ finishedCallback
  ) {
    this.updateValueCallback = updateValueCallback;
    this.finishedCallback = finishedCallback;
    let el = pot;
    this.cx = 0;
    this.cy = 0;
    do {
      this.cx += el.offsetLeft;
      this.cy += el.offsetTop;
      el = el.offsetParent;
    } while (el);
    this.cx += 28;
    this.cy += 36;
    this.isDragging = true;
    this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
    DOM.addClass(document.body, 'dragvalue');
  }

  move(/** @type {MouseEvent} */ e) {
    if (this.isDragging) {
      this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
    }
  }

  stopDrag(/** @type {MouseEvent} */ e) {
    if (this.isDragging) {
      this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
      DOM.removeClass(document.body, 'dragvalue');
      this.isDragging = false;
      this.finishedCallback();
    }
  }
}

module.exports = new PotDragHandler();
