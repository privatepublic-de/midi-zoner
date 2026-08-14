interface HistoryEntry {
  snapshot: string;
  label: string;
}

export class UndoHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private pendingSnapshot: string | null = null;
  private pendingLabel: string = '';
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

  // Label of the action that would be undone/redone next, for display (e.g. button tooltips).
  get undoLabel(): string | null {
    return this.undoStack.length
      ? this.undoStack[this.undoStack.length - 1].label
      : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length
      ? this.redoStack[this.redoStack.length - 1].label
      : null;
  }

  // Call before a discrete mutation (no-op during gesture)
  beforeAction(zonesJSON: string, label: string): void {
    if (!this.gestureActive) {
      this.pendingSnapshot = zonesJSON;
      this.pendingLabel = label;
    }
  }

  // Call after a discrete mutation (no-op during gesture)
  afterAction(currentZonesJSON: string): void {
    if (!this.gestureActive && this.pendingSnapshot !== null) {
      if (this.pendingSnapshot !== currentZonesJSON) {
        this.push(this.pendingSnapshot, this.pendingLabel);
      }
      this.pendingSnapshot = null;
    }
  }

  // Idempotent — only captures snapshot on the first call within a gesture
  startGesture(zonesJSON: string, label: string): void {
    if (!this.gestureActive) {
      this.pendingSnapshot = zonesJSON;
      this.pendingLabel = label;
      this.gestureActive = true;
    }
  }

  // Commits the pre-gesture snapshot as one undo entry (if state changed)
  endGesture(currentZonesJSON: string): void {
    if (this.gestureActive) {
      if (this.pendingSnapshot !== null && this.pendingSnapshot !== currentZonesJSON) {
        this.push(this.pendingSnapshot, this.pendingLabel);
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
  push(zonesJSON: string, label: string): void {
    this.undoStack.push({ snapshot: zonesJSON, label });
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.onChange?.();
  }

  // Returns snapshot to restore; pushes current state onto redo stack
  undo(currentZonesJSON: string): string | null {
    if (this.undoStack.length === 0) return null;
    const entry = this.undoStack.pop()!;
    this.redoStack.push({ snapshot: currentZonesJSON, label: entry.label });
    this.onChange?.();
    return entry.snapshot;
  }

  // Returns snapshot to restore; pushes current state onto undo stack
  redo(currentZonesJSON: string): string | null {
    if (this.redoStack.length === 0) return null;
    const entry = this.redoStack.pop()!;
    this.undoStack.push({ snapshot: currentZonesJSON, label: entry.label });
    this.onChange?.();
    return entry.snapshot;
  }
}
