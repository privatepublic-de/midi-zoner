import DOM from '../domutils';
import { ToastProperties } from './types';

let toastElement: HTMLElement;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastMS = 0;
let hovered = false;

export function initToast(): void {
  toastElement = DOM.get('#toast') as HTMLElement;
  toastElement.addEventListener('click', () => {
    clearTimer();
    toastHide();
  });
  toastElement.addEventListener('animationend', () => {
    toastElement.classList.remove('bump');
  });
  // reading: stays while the mouse is on it, then gives a moment more
  toastElement.addEventListener('mouseenter', () => {
    hovered = true;
    if (toastTimer) clearTimeout(toastTimer);
  });
  toastElement.addEventListener('mouseleave', () => {
    hovered = false;
    if (toastElement.classList.contains('fade')) startTimer(Math.min(toastMS, 2500));
  });
}

function clearTimer(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

function startTimer(ms: number): void {
  clearTimer();
  if (hovered) return;
  toastTimer = setTimeout(() => {
    toastHide();
    toastTimer = null;
  }, ms);
}

/** Time to read: a base plus ~70 ms per character beyond a short line, at most 15 s. */
function readingTime(text: string, warning: boolean): number {
  const base = warning ? 6000 : 4000;
  return Math.min(15000, base + Math.max(0, text.length - 40) * 70);
}

export function toast(message: string, properties?: ToastProperties): void {
  const isUpdate = toastElement.classList.contains('fade');
  const warning = properties?.warning ?? false;
  if (warning) {
    DOM.addClass('#toast', 'warning');
  } else {
    DOM.removeClass('#toast', 'warning');
  }
  const inner = DOM.get('#toast .toastinner') as HTMLElement;
  inner.innerHTML = message;
  toastElement.style.bottom = toastElement.style.right = '';
  if (isUpdate) {
    toastElement.classList.remove('bump');
    void toastElement.offsetWidth; // force reflow to restart animation
    toastElement.classList.add('bump');
  }
  toastShow();
  toastMS = readingTime(inner.textContent ?? '', warning);
  startTimer(toastMS);
}

export function toastHide(): void {
  toastElement.classList.remove('fade');
}

export function toastShow(): void {
  toastElement.classList.add('fade');
}
