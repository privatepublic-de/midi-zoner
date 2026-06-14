export class UndoHistory {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pendingSnapshot: string | null = null;
  private gestureActive = false;
  private readonly maxSize: number;
  onChange: (() => void) | null = null;

  constructor(maxSize = 20) {
    this.maxSize = maxSize;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // Call before a discrete mutation (no-op during gesture)
  beforeAction(zonesJSON: string): void {
    if (!this.gestureActive) {
      this.pendingSnapshot = zonesJSON;
    }
  }

  // Call after a discrete mutation (no-op during gesture)
  afterAction(currentZonesJSON: string): void {
    if (!this.gestureActive && this.pendingSnapshot !== null) {
      if (this.pendingSnapshot !== currentZonesJSON) {
        this.push(this.pendingSnapshot);
      }
      this.pendingSnapshot = null;
    }
  }

  // Idempotent — only captures snapshot on the first call within a gesture
  startGesture(zonesJSON: string): void {
    if (!this.gestureActive) {
      this.pendingSnapshot = zonesJSON;
      this.gestureActive = true;
    }
  }

  // Commits the pre-gesture snapshot as one undo entry (if state changed)
  endGesture(currentZonesJSON: string): void {
    if (this.gestureActive) {
      if (this.pendingSnapshot !== null && this.pendingSnapshot !== currentZonesJSON) {
        this.push(this.pendingSnapshot);
      }
      this.pendingSnapshot = null;
      this.gestureActive = false;
    }
  }

  cancelGesture(): void {
    this.pendingSnapshot = null;
    this.gestureActive = false;
  }

  // Direct push — for scene file load or other explicit checkpoints
  push(zonesJSON: string): void {
    this.undoStack.push(zonesJSON);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.onChange?.();
  }

  // Returns snapshot to restore; pushes current state onto redo stack
  undo(currentZonesJSON: string): string | null {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(currentZonesJSON);
    const snapshot = this.undoStack.pop()!;
    this.onChange?.();
    return snapshot;
  }

  // Returns snapshot to restore; pushes current state onto undo stack
  redo(currentZonesJSON: string): string | null {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(currentZonesJSON);
    const snapshot = this.redoStack.pop()!;
    this.onChange?.();
    return snapshot;
  }
}
