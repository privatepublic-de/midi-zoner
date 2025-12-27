import DOM from '../../domutils';
import { ActionContext, ActionHelpers, ActionMap } from '../types';

export function createFilterActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const { zone, zoneindex, element } = ctx;
  const { applyParamToggle, applyPercentage } = helpers;

  return {
    filters_toggle: () => {
      const settings = zone._$('.popupsettings') as HTMLElement;
      if (settings.style.display == 'flex') {
        settings.style.display = 'none';
      } else {
        settings.style.display = 'flex';
      }
    },
    filters_fixedvel_value: () => {
      zone.fixedvel_value = parseInt((zone._$('input.fixedvel_value') as HTMLInputElement).value);
    },
    filters_fixedvel: function() {
      this.filters_fixedvel_value();
      applyParamToggle();
    },
    filters_velocity_scaling: applyPercentage,
    filters_cc: applyParamToggle,
    filters_sustain: applyParamToggle,
    filters_sustain_on: applyParamToggle,
    filters_mod: applyParamToggle,
    filters_at2mod: applyParamToggle,
    filters_pitchbend: applyParamToggle,
    filters_programchange: applyParamToggle,
    filters_changeprogram: () => {
      const v = parseInt((element as HTMLInputElement).value);
      if (v > 0 && v < 129) {
        zone.pgm_no = v;
        zone.sendProgramChange();
      }
    },
  };
}
