import DOM from '../../domutils';
import { ActionContext, ActionHelpers, ActionMap } from '../types';

export function createArpActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const { zone, zoneindex, element, actionParam1, ev, updateValuesForZone } = ctx;
  const { applyParamToggle, applySelectedIndex, applyPercentage } = helpers;

  return {
    zone_arp_enabled: () => {
      applyParamToggle();
      if (zone.arp_enabled) {
        updateValuesForZone(zoneindex);
        zone.renderPattern();
      }
      zone.renderNotes();
    },
    zone_arp_hold: () => {
      applyParamToggle();
      zone.renderNotes();
    },
    zone_arp_transpose: applyParamToggle,
    zone_arp_repeat: applyParamToggle,
    zone_arp_direction: applySelectedIndex,
    zone_arp_octaves: applySelectedIndex,
    zone_arp_division: applySelectedIndex,
    zone_arp_probability: applyPercentage,
    zone_arp_gatelength: applyPercentage,
    zone_arp_pattern: () => {
      if ((ev.target as HTMLElement).tagName == 'CANVAS') {
        const index = parseInt(
          String((ev.offsetX / element.offsetWidth) * zone.arp_pattern.length)
        );
        zone.arp_pattern[index] = !zone.arp_pattern[index];
        zone.renderPattern();
      }
    },
    zone_arp_showeuclid: () => {
      const dialog = zone._$('.euclid') as HTMLElement;
      if (dialog.style.display == 'block') {
        DOM.hide(dialog);
      } else {
        DOM.show(dialog);
      }
    },
    zone_arp_euclid: () => {
      let hits = parseInt((zone._$('.euchits') as HTMLInputElement).value);
      let len = parseInt((zone._$('.euclen') as HTMLInputElement).value);
      if (!isNaN(hits) && !isNaN(len)) {
        hits = Math.min(32, Math.max(1, hits));
        len = Math.min(32, Math.max(2, len));
        zone.createEuclidianPattern(len, hits);
      }
    },
    zone_arp_pattern_shift: () => {
      if (actionParam1 == '-1') {
        zone.arp_pattern.push(zone.arp_pattern.shift()!);
      } else if (actionParam1 == '1') {
        zone.arp_pattern.unshift(zone.arp_pattern.pop()!);
      }
      zone.renderPattern();
    },
  };
}
