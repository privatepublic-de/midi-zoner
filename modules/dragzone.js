const { webFrame } = require('electron');

module.exports = class DragZone {
  index = null;
  srcdim = null;
  moveHandler = null;
  dropHandler = null;
  hasmoved = false;
  zoneElement = null;
  startY = 0;
  startX = 0;
  finishedCallback = null;

  constructor(index, startMouseEvent, finishedCallback) {
    this.zoomFactor = webFrame.getZoomFactor();
    this.finishedCallback = finishedCallback;
    this.zoneElement = DOM.element(`#zone${index}`);
    this.index = index;
    this.startY = 0;
    this.startX = 0;
    this.srcdim = {
      top: this.zoneElement.offsetTop,
      left: this.zoneElement.offsetLeft,
      width: this.zoneElement.offsetWidth,
      height: this.zoneElement.offsetHeight,
      offsetTop: 5
    };
    DOM.addClass(this.zoneElement, 'dragged');
    this.moveHandler = this.move.bind(this);
    this.dropHandler = this.drop.bind(this);
    this.startY = startMouseEvent.screenY / this.zoomFactor;
    this.startX = startMouseEvent.screenX / this.zoomFactor;
    this.zoneElement.style.top = `${this.srcdim.top}px`;
    this.zoneElement.style.left = `${this.srcdim.left}px`;
    this.zoneElement.style.width = `${this.srcdim.width}px`;
    this.zoneElement.style.height = `${this.srcdim.height}px`;
    document.body.addEventListener('mousemove', this.moveHandler, true);
    document.body.addEventListener('mouseup', this.dropHandler, true);
    DOM.addClass(document.body, 'zonedrag');
    this.findDropElement(startMouseEvent.screenY); // this.startY);
    setTimeout(() => {
      DOM.addClass('#zones', 'dragging');
    }, 100);
  }

  move(ev) {
    this.findDropElement(ev.screenX, ev.screenY);
    this.hasmoved = true;
  }

  drop(ev) {
    let targetIndex = this.findDropElement(ev.screenY);
    document.body.removeEventListener('mousemove', this.moveHandler, true);
    document.body.removeEventListener('mouseup', this.dropHandler, true);
    DOM.removeClass('#zones', 'dragging');
    DOM.removeClass(document.body, 'zonedrag');
    DOM.all(`.zone`).forEach((el) => {
      el.style.marginTop = '';
      el.style.marginBottom = '';
    });
    this.zoneElement.style.display = 'block';
    if (this.hasmoved) {
      const me = zones.list.splice(this.index, 1);
      if (targetIndex > this.index) {
        targetIndex--;
      }
      zones.list.splice(targetIndex, 0, me[0]);
    }
    this.finishedCallback();
  }

  findDropElement(screenX, screenY) {
    const y = this.srcdim.top + (screenY / this.zoomFactor - this.startY);
    const x = this.srcdim.left + (screenX / this.zoomFactor - this.startX);
    this.zoneElement.style.top = `${y - this.srcdim.offsetTop}px`;
    this.zoneElement.style.left = `${x - this.srcdim.offsetLeft}px`;
    let found = -1;
    let z;
    let nearestTop = window.innerHeight;
    let nearestTopIndex;
    for (let i = 0; i < zones.list.length; i++) {
      if (i === this.index) {
        continue;
      }
      z = DOM.element(`#zone${i}`);
      const dist = Math.abs(y + this.srcdim.height / 2 - z.offsetTop);
      if (dist < nearestTop) {
        nearestTop = dist;
        nearestTopIndex = i;
      }
    }
    // DOM.all(`.zone`).forEach((el) => {
    //   el.style.marginTop = '';
    //   el.style.marginBottom = '';
    // });
    if (nearestTopIndex === zones.list.length - 1 && y > z.offsetTop) {
      // DOM.element(`#zone${nearestTopIndex}`).style.marginBottom = `${
      //   this.srcdim.height + 10
      // }px`;
      found = nearestTopIndex + 1;
    } else {
      // DOM.element(`#zone${nearestTopIndex}`).style.marginTop = `${
      //   this.srcdim.height + 10
      // }px`;
      found = nearestTopIndex;
    }
    return found;
  }
};
