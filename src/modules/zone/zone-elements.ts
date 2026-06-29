export class ZoneElements {
  isReady = false;
  zoneElement: HTMLElement | null = null;
  actionElements: NodeListOf<HTMLElement> | null = null;
  canvasElement: HTMLCanvasElement | null = null;
  patternCanvas: HTMLCanvasElement | null = null;
  sequencerElement: HTMLElement | null = null;
  sequencerGridElement: HTMLElement | null = null;
  sequencerGridStepElements: NodeListOf<HTMLElement> | HTMLElement[] = [];
  sequencerDrumStepElements: NodeListOf<HTMLElement> | HTMLElement[] = [];
  sequencerDrumLanes: (NodeListOf<HTMLElement> | HTMLElement[])[] = [];
  sequencerProgressElement: HTMLElement | null = null;
  sequencerProgressElementInner: HTMLElement | null = null;
  sequencerDrumLaneCursors: HTMLElement[] = [];
  rangeContainer: HTMLElement | null = null;
  rangeMarkerLow: HTMLElement | null = null;
  rangeMarkerHigh: HTMLElement | null = null;
  rangeJoin: HTMLElement | null = null;
  rangeCurrent: HTMLElement | null = null;
  octaveSelectors: NodeListOf<HTMLElement> | null = null;
  ccPots: NodeListOf<HTMLElement> | null = null;
  private cachedElements: Record<string, HTMLElement | null> = {};

  init(index: number): void {
    this.cachedElements = {};
    this.zoneElement = document.querySelector(`#zone${index}`);
    if (!this.zoneElement) return;

    this.actionElements = this.zoneElement.querySelectorAll('*[data-action]');
    this.canvasElement = this.zoneElement.querySelector(`#canvas${index}`);
    this.patternCanvas = this.zoneElement.querySelector(`#canvasPattern${index}`);
    this.sequencerElement = this.zoneElement.querySelector('.seq');
    this.sequencerGridElement = this.zoneElement.querySelector('.grid');
    this.sequencerProgressElement = this.zoneElement.querySelector('.seqprogress');
    this.sequencerProgressElementInner = this.zoneElement.querySelector('.seqprogress .inner');
    this.sequencerGridStepElements = this.zoneElement.querySelectorAll('.seq .grid .step-container .step');
    this.sequencerDrumStepElements = this.zoneElement.querySelectorAll('.seq .grid .drum-step-container .step');
    this.sequencerDrumLanes = [];
    this.zoneElement.querySelectorAll('.drum-lane').forEach((dl) => {
      this.sequencerDrumLanes.push(dl.querySelectorAll('.step'));
    });
    this.rangeContainer = this.zoneElement.querySelector('.range');
    this.rangeMarkerLow = this.zoneElement.querySelector('.marker.low');
    this.rangeMarkerHigh = this.zoneElement.querySelector('.marker.high');
    this.rangeJoin = this.zoneElement.querySelector('.join');
    this.rangeCurrent = this.zoneElement.querySelector('.current');
    this.octaveSelectors = this.zoneElement.querySelectorAll('.octselect');
    this.ccPots = this.zoneElement.querySelectorAll('.ccpots');
    this.isReady = true;
  }

  reset(): void {
    this.isReady = false;
    this.cachedElements = {};
  }

  emptyCache(): void {
    this.cachedElements = {};
  }

  private getCachedElement(selector: string): HTMLElement | null {
    if (!this.cachedElements[selector]) {
      this.cachedElements[selector] = this.zoneElement?.querySelector(selector) || null;
    }
    return this.cachedElements[selector];
  }

  addSelectedStyle(selector: string, isSelected: boolean): void {
    const el = this.getCachedElement(selector);
    if (isSelected) {
      el?.classList.add('selected');
    } else {
      el?.classList.remove('selected');
    }
  }

  setSelectedIndex(selector: string, index: number): void {
    const el = this.getCachedElement(selector) as HTMLSelectElement;
    if (el) el.selectedIndex = index;
  }

  setPercentage(selector: string, percentage: number, zoneIndex: number): void {
    const el = this.getCachedElement(selector) as HTMLInputElement;
    if (el) el.value = String(percentage);
    let outputSelector = selector;
    if (outputSelector.startsWith('.')) {
      outputSelector = outputSelector.substring(1);
    }
    const outputEl = this.getCachedElement(`output[for="${outputSelector}${zoneIndex}"]`);
    if (outputEl) (outputEl as HTMLOutputElement).value = percentage + '%';
  }

  get(selector: string): HTMLElement | null {
    return this.getCachedElement(selector);
  }
}
