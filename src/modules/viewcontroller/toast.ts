import DOM from '../domutils';
import { ToastProperties } from './types';

let toastElement: HTMLElement;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function initToast(): void {
  toastElement = DOM.get('#toast') as HTMLElement;
  toastElement.addEventListener('click', () => {
    toastHide();
  });
  toastElement.addEventListener('animationend', () => {
    toastElement.classList.remove('bump');
  });
}

export function toast(message: string, properties?: ToastProperties): void {
  const isUpdate = toastTimer !== null;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  const warning = properties?.warning ?? false;
  const timeoutMS = warning ? 6000 : 4000;
  if (warning) {
    DOM.addClass('#toast', 'warning');
  } else {
    DOM.removeClass('#toast', 'warning');
  }
  (DOM.get('#toast .toastinner') as HTMLElement).innerHTML = message;
  toastElement.style.bottom = toastElement.style.right = '';
  if (isUpdate) {
    toastElement.classList.remove('bump');
    void toastElement.offsetWidth; // force reflow to restart animation
    toastElement.classList.add('bump');
  }
  toastShow();
  toastTimer = setTimeout(() => {
    toastHide();
    toastTimer = null;
  }, timeoutMS);
}

export function toastHide(): void {
  toastElement.classList.remove('fade');
}

export function toastShow(): void {
  toastElement.classList.add('fade');
}
