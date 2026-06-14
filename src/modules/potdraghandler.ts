import DOM from './domutils';

type UpdateValueCallback = (value: number) => void;
type FinishedCallback = () => void;

// Units per pixel in 0-16383 space. 7-bit controllers use v>>7 at call site,
// so SENSITIVITY=80 gives ~200px for full 0-127 sweep; FINE gives ~2000px.
const SENSITIVITY = 80;
const FINE_SENSITIVITY = 8;

class PotDragHandler {
  isDragging = false;
  anchorY = 0;
  anchorValue = 0;
  lastValue = 0;
  shiftActive = false;
  updateValueCallback: UpdateValueCallback | null = null;
  finishedCallback: FinishedCallback | null = null;

  constructor() {
    window.addEventListener('mousemove', this.move.bind(this));
    window.addEventListener('mouseup', this.stopDrag.bind(this));
  }

  startDrag(
    e: MouseEvent,
    currentValue: number,
    updateValueCallback: UpdateValueCallback,
    finishedCallback: FinishedCallback
  ): void {
    this.updateValueCallback = updateValueCallback;
    this.finishedCallback = finishedCallback;
    this.anchorY = e.pageY;
    this.anchorValue = currentValue;
    this.lastValue = currentValue;
    this.shiftActive = e.shiftKey;
    this.isDragging = true;
    DOM.addClass(document.body, 'dragvalue');
  }

  private computeValue(mouseY: number, shiftKey: boolean): number {
    if (shiftKey !== this.shiftActive) {
      // Re-anchor when shift is toggled so value doesn't jump on sensitivity change
      this.anchorY = mouseY;
      this.anchorValue = this.lastValue;
      this.shiftActive = shiftKey;
    }
    const sensitivity = this.shiftActive ? FINE_SENSITIVITY : SENSITIVITY;
    const delta = Math.round((this.anchorY - mouseY) * sensitivity);
    return Math.max(0, Math.min(16383, this.anchorValue + delta));
  }

  move(e: MouseEvent): void {
    if (!this.isDragging || !this.updateValueCallback) return;
    const newValue = this.computeValue(e.pageY, e.shiftKey);
    if (newValue !== this.lastValue) {
      this.lastValue = newValue;
      this.updateValueCallback(newValue);
    }
  }

  stopDrag(e: MouseEvent): void {
    if (!this.isDragging || !this.updateValueCallback || !this.finishedCallback) return;
    const newValue = this.computeValue(e.pageY, e.shiftKey);
    if (newValue !== this.lastValue) {
      this.lastValue = newValue;
      this.updateValueCallback(newValue);
    }
    DOM.removeClass(document.body, 'dragvalue');
    this.isDragging = false;
    this.finishedCallback();
  }
}

export default new PotDragHandler();
