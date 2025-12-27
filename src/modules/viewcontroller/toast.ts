import DOM = require('../domutils');
import { ToastProperties } from './types';

let toastElement: HTMLElement;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function initToast(): void {
  toastElement = DOM.get('#toast') as HTMLElement;
}

export function toast(message: string, properties?: ToastProperties): void {
  const longer = properties ? properties.longer : false;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  const warning = properties ? properties.warning : false;
  let timeoutMS = 2000;
  if (warning) {
    DOM.addClass('#toast', 'warning');
    timeoutMS += 5000;
  } else {
    DOM.removeClass('#toast', 'warning');
  }
  if (longer) {
    timeoutMS += 5000;
  }
  (DOM.get('#toast .toastinner') as HTMLElement).innerHTML = message;
  toastElement.style.top = toastElement.style.left = '';
  toastShow(longer);
  toastTimer = setTimeout(
    () => {
      toastHide();
      toastTimer = null;
    },
    longer ? 5000 : 2000
  );
}

export function toastHide(): void {
  DOM.hide(toastElement);
}

export function toastShow(longer?: boolean): void {
  DOM.show(toastElement);
}
