import { ActionContext, ActionHelpers, ActionMap } from '../types';

export function createArpActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const { zone, zoneindex, element, actionParam1, ev, updateValuesForZone } = ctx;
  const { applyParamToggle, applySelectedIndex, applyPercentage } = helpers;

  /** A number field of this zone, clamped to [min, max]; empty or invalid keeps `current`. */
  const clampedValue = (selector: string, min: number, max: number, current: number): number => {
    const v = parseInt((zone._$(selector) as HTMLInputElement).value);
    return isNaN(v) ? current : Math.max(min, Math.min(max, v));
  };

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
    zone_arp_strum_taper: applyPercentage,
    zone_arp_ratchet_probability: applyPercentage,
    zone_arp_ratchet_count: applySelectedIndex,
    zone_arp_pattern: () => {
      const cell = (ev.target as HTMLElement).closest('.pattern > i');
      if (cell) {
        const index = Array.prototype.indexOf.call(element.children, cell);
        zone.arp_pattern[index] = !zone.arp_pattern[index];
        zone.syncEuclidToPattern();
        zone.renderPattern();
      }
    },
    zone_arp_euclid: () => {
      const len = clampedValue('.euclen', 2, 32, zone.euclid_length);
      // hits are not clamped to len: typing a two-digit length passes through one digit
      const hits = clampedValue('.euchits', 1, 32, zone.euclid_hits);
      zone.createEuclidianPattern(len, hits);
    },
    zone_arp_pattern_shift: () => {
      if (actionParam1 == '-1') {
        zone.arp_pattern.push(zone.arp_pattern.shift()!);
      } else if (actionParam1 == '1') {
        zone.arp_pattern.unshift(zone.arp_pattern.pop()!);
      }
      zone.renderPattern();
    },
    zone_swing_amount: () => {
      zone.swingAmount = parseInt((element as HTMLInputElement).value) / 100;
      updateValuesForZone(zoneindex);
    },
  };
}
