import DOM from '../domutils';

export class NumberInputController {
  elValueDown: HTMLElement | null = null;
  elValueUp: HTMLElement | null = null;
  elValueBtnAttachedInput: HTMLInputElement | null = null;
  timeoutValueRepeatDelay: ReturnType<typeof setTimeout> | null = null;
  intervalValueRepeat: ReturnType<typeof setInterval> | null = null;
  valueRepeatIncrement = 0;
  onAttach: (() => void) | null = null;
  onDetach: (() => void) | null = null;

  constructor() {
    this.elValueUp = DOM.get('#valueUp') as HTMLElement;
    this.elValueDown = DOM.get('#valueDown') as HTMLElement;
    this.elValueBtnAttachedInput = null;
    this.elValueUp.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev as MouseEvent, 1)
    );
    this.elValueDown.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev as MouseEvent, -1)
    );
    this.elValueUp.addEventListener('mouseup', (ev) => this.endValueChange(ev as MouseEvent));
    this.elValueDown.addEventListener('mouseup', (ev) =>
      this.endValueChange(ev as MouseEvent)
    );
    this.elValueUp.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput!);
    });
    this.elValueDown.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput!);
    });
  }

  changeAttachedInputValue(v: number): void {
    if (this.elValueBtnAttachedInput) {
      let nv: number;
      if (this.elValueBtnAttachedInput.value == '') {
        nv = parseInt(this.elValueBtnAttachedInput.min);
      } else {
        nv = parseInt(this.elValueBtnAttachedInput.value) + v;
      }
      if (
        nv >= parseInt(this.elValueBtnAttachedInput.min) &&
        nv <= parseInt(this.elValueBtnAttachedInput.max)
      ) {
        this.elValueBtnAttachedInput.value = String(nv);
        this.elValueBtnAttachedInput.dispatchEvent(new CustomEvent('input'));
      }
      this.elValueBtnAttachedInput.focus();
    }
  }

  startValueChange(ev: MouseEvent, v: number): void {
    ev.preventDefault();
    this.valueRepeatIncrement = v;
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = setTimeout(() => {
      this.intervalValueRepeat = setInterval(() => {
        this.changeAttachedInputValue(this.valueRepeatIncrement);
      }, 80);
    }, 400);
  }

  endValueChange(ev: MouseEvent): void {
    ev.preventDefault();
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) {
      clearInterval(this.intervalValueRepeat);
    } else {
      this.changeAttachedInputValue(this.valueRepeatIncrement);
    }
  }

  breakValueChange(ev?: MouseEvent): void {
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = null;
  }

  addInputElements(elementlist: Element[]): void {
    elementlist.forEach((e) => {
      e.addEventListener('mouseenter', (ev) => {
        this.attachValueButtons(e as HTMLInputElement);
      });
      e.addEventListener('mouseleave', (ev) => {
        this.breakValueChange(ev as MouseEvent);
        if (
          (ev as MouseEvent).relatedTarget &&
          ((ev as MouseEvent).relatedTarget as HTMLElement).classList.contains('valuebtn')
        ) {
          return;
        }
        this.detachValueButtons(e as HTMLInputElement);
      });
    });
  }

  attachValueButtons(inputelement: HTMLInputElement): void {
    if (inputelement.disabled) return;
    this.onAttach?.();
    this.elValueBtnAttachedInput = inputelement;
    this.elValueUp!.style.display = this.elValueDown!.style.display = 'block';
    const valueUpRect = this.elValueUp!.getBoundingClientRect();
    const inputElementOffsets = DOM.clientOffsets(inputelement);
    this.elValueDown!.style.top = this.elValueUp!.style.top =
      window.scrollY +
      inputElementOffsets.offsetTop +
      inputElementOffsets.offsetHeight / 2 -
      valueUpRect.height / 2 +
      'px';
    this.elValueUp!.style.left =
      inputElementOffsets.offsetLeft +
      inputElementOffsets.offsetWidth -
      valueUpRect.width +
      'px';
    this.elValueDown!.style.left = inputElementOffsets.offsetLeft + 'px';
  }

  detachValueButtons(inputelement: HTMLInputElement): void {
    this.breakValueChange();
    this.onDetach?.();
    this.elValueUp!.style.display = this.elValueDown!.style.display = 'none';
  }
}
