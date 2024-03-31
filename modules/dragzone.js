const { webFrame } = require('electron');
const DOM = require('./domutils');

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
    const offsets = DOM.clientOffsets(this.zoneElement);
    const containerOffsets = DOM.clientOffsets(DOM.element('#zones'));
    this.srcdim = {
      top: offsets.offsetTop,
      left: offsets.offsetLeft,
      width: this.zoneElement.offsetWidth,
      height: this.zoneElement.offsetHeight,
      offsetTop: containerOffsets.offsetTop,
      offsetLeft: containerOffsets.offsetLeft
    };
    DOM.addClass(this.zoneElement, 'dragged');
    const placeholder = DOM.addHTML(
      this.zoneElement,
      'afterend',
      `<section class="zone" style="height:${this.srcdim.height}px"></section>`
    );
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
    this.findDropElement(startMouseEvent.screenX, startMouseEvent.screenY); // this.startY);
    setTimeout(() => {
      DOM.addClass('#zones', 'dragging');
    }, 100);
  }

  move(ev) {
    this.findDropElement(ev.screenX, ev.screenY);
    this.hasmoved = true;
  }

  drop(ev) {
    let targetIndex = this.findDropElement(ev.screenX, ev.screenY);
    document.body.removeEventListener('mousemove', this.moveHandler, true);
    document.body.removeEventListener('mouseup', this.dropHandler, true);
    DOM.removeClass('#zones', 'dragging');
    DOM.removeClass('#zones', 'droptarget');
    DOM.removeClass(document.body, 'zonedrag');
    this.zoneElement.style.display = 'block';
    if (this.hasmoved && targetIndex > -1) {
      const temp = zones.list[targetIndex];
      zones.list[targetIndex] = zones.list[this.index];
      zones.list[this.index] = temp;
    }
    this.finishedCallback();
  }

  findDropElement(screenX, screenY) {
    const my = (screenY - this.srcdim.offsetTop) / this.zoomFactor;
    const mx = (screenX - this.srcdim.offsetLeft) / this.zoomFactor;
    const y = this.srcdim.top + (screenY / this.zoomFactor - this.startY);
    const x = this.srcdim.left + (screenX / this.zoomFactor - this.startX);
    this.zoneElement.style.top = `${y}px`;
    this.zoneElement.style.left = `${x}px`;
    let found = -1;
    let z;
    // let nearestTop = window.innerHeight;
    // let nearestTopIndex;
    for (let i = 0; i < zones.list.length; i++) {
      if (i === this.index) {
        continue;
      }
      z = DOM.element(`#zone${i}`);
      const offs = DOM.clientOffsets(z);

      if (
        mx < offs.offsetLeft + z.offsetWidth &&
        mx > offs.offsetLeft &&
        my < offs.offsetTop + z.offsetHeight &&
        my > offs.offsetTop
      ) {
        found = i;
        DOM.addClass(z, 'droptarget');
      } else {
        DOM.removeClass(z, 'droptarget');
      }
    }
    // if (nearestTopIndex === zones.list.length - 1 && y > z.offsetTop) {
    //   found = nearestTopIndex + 1;
    // } else {
    //   found = nearestTopIndex;
    // }
    return found;
  }
};
