import { createFilterActions } from './filter-actions';
import { createZoneActions } from './zone-actions';
import { createArpActions } from './arp-actions';
import { createCCActions } from './cc-actions';
import { createSeqActions } from './seq-actions';
import { ActionContext, ActionHelpers, ActionMap, ZoneType } from '../types';

export function createActionHandlers(
  ctx: ActionContext,
  helpers: ActionHelpers,
  renderControllersForZone: (zone: ZoneType, index: number) => void
): ActionMap {
  return {
    ...createFilterActions(ctx, helpers),
    ...createZoneActions(ctx, helpers),
    ...createArpActions(ctx, helpers),
    ...createCCActions(ctx, helpers, renderControllersForZone),
    ...createSeqActions(ctx, helpers),
  };
}

export { createFilterActions } from './filter-actions';
export { createZoneActions } from './zone-actions';
export { createArpActions } from './arp-actions';
export { createCCActions } from './cc-actions';
export { createSeqActions, ratchetResToLabel } from './seq-actions';
