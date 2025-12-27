import DOM = require('./domutils');

type UpdateValueCallback = (value: number) => void;
type FinishedCallback = () => void;

class PotDragHandler {
  isDragging = false;
  cx = 0;
  cy = 0;
  updateValueCallback: UpdateValueCallback | null = null;
  finishedCallback: FinishedCallback | null = null;

  constructor() {
    window.addEventListener('mousemove', this.move.bind(this));
    window.addEventListener('mouseup', this.stopDrag.bind(this));
  }

  valueForCoordinates(x: number, y: number): number {
    const y0 = y - this.cy;
    const x0 = x - this.cx;
    let ang = parseInt(String(Math.atan2(y0, x0) * (180 / Math.PI)));
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
    return Math.floor((ang / 270.0) * 16383);
  }

  startDrag(
    pot: HTMLElement,
    e: MouseEvent,
    updateValueCallback: UpdateValueCallback,
    finishedCallback: FinishedCallback
  ): void {
    this.updateValueCallback = updateValueCallback;
    this.finishedCallback = finishedCallback;
    let el: HTMLElement | null = pot;
    this.cx = 0;
    this.cy = 0;
    do {
      this.cx += el.offsetLeft;
      this.cy += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    } while (el);
    this.cx += 30;
    this.cy += 48;
    this.isDragging = true;
    this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
    DOM.addClass(document.body, 'dragvalue');
  }

  move(e: MouseEvent): void {
    if (this.isDragging && this.updateValueCallback) {
      this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
    }
  }

  stopDrag(e: MouseEvent): void {
    if (this.isDragging && this.updateValueCallback && this.finishedCallback) {
      this.updateValueCallback(this.valueForCoordinates(e.pageX, e.pageY));
      DOM.removeClass(document.body, 'dragvalue');
      this.isDragging = false;
      this.finishedCallback();
    }
  }
}

export = new PotDragHandler();
