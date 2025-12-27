import { Zone } from '../../zone/zone-class';
import { Sequence } from '../../zone/sequence';
import { ActionContext, ActionHelpers, ActionMap } from '../types';

export function createSeqActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const {
    zone, zoneindex, sequence, element, actionParam1, ev,
    updateValuesForZone, toast
  } = ctx;
  const { calcAndDisplayPercentage } = helpers;

  const actions: ActionMap = {
    toggle_seq: () => {
      sequence.active = !sequence.active;
      sequence.clearSelection();
      if (sequence.active) {
        zone.renderNotes();
      } else {
        sequence.isLiveRecoding = false;
      }
      updateValuesForZone(zoneindex);
    },
    seq_division: () => {
      sequence.division = (element as HTMLSelectElement).selectedIndex;
      updateValuesForZone(zoneindex);
    },
    seq_steps: () => {
      const v = parseInt((element as HTMLInputElement).value);
      sequence.length = v;
      updateValuesForZone(zoneindex);
    },
    seq_drum_lanes: () => {
      sequence.drumLanes = parseInt((element as HTMLInputElement).value);
      updateValuesForZone(zoneindex);
    },
    seq_drumlane_note: () => {
      const laneNo = parseInt(actionParam1);
      sequence.getDrumLane(laneNo).note = parseInt((element as HTMLInputElement).value);
      console.log(sequence.getDrumLane(laneNo));
      updateValuesForZone(zoneindex);
    },
    seq_drumstep_select: () => {
      if (ev.shiftKey) {
        actions.seq_clear_step();
      } else {
        sequence.turnOnDrumStep(
          ...Sequence.getLaneAndStepIndexForDrumStepId(parseInt(actionParam1))
        );
      }
      updateValuesForZone(zoneindex);
    },
    seq_toggle_lane_enabled: () => {
      const dl = sequence.getDrumLane(parseInt(actionParam1));
      dl.enabled = !dl.enabled;
      updateValuesForZone(zoneindex);
    },
    seq_step_length: () => {
      const v = parseInt((element as HTMLInputElement).value);
      sequence.selectedStepNumbers.forEach((n) => {
        if (sequence.steps[n]) sequence.steps[n].length = v;
      });
      updateValuesForZone(zoneindex);
    },
    seq_clear_all: () => {
      if (sequence.isDrumSequence) {
        for (let i = 0; i < Sequence.MAX_LANES_DRUMS; i++) {
          const lane = sequence.getDrumLane(i);
          lane.steps.length = 0;
        }
        updateValuesForZone(zoneindex);
        sequence.selectedStepNumber = sequence.selectedStepNumber;
        toast('Drum sequence lanes cleared');
      } else {
        sequence.steps.length = 0;
        updateValuesForZone(zoneindex);
        sequence.selectedStepNumber = sequence.selectedStepNumber;
        toast('Sequence cleared');
      }
    },
    seq_transpose: () => {
      const selectElement = element as HTMLSelectElement;
      const semitones = parseInt(selectElement.options[selectElement.selectedIndex].value);
      sequence.transpose(semitones);
      toast(
        (sequence.hasSelection ? 'Selected steps' : 'Sequence') +
          ' transposed by ' +
          semitones +
          ' semitones'
      );
      selectElement.selectedIndex = 0;
      updateValuesForZone(zoneindex);
    },
    seq_adjust: () => {
      const selectElement = element as HTMLSelectElement;
      const adjustment = selectElement.options[selectElement.selectedIndex].value;
      let seq = sequence;
      let srcLength = seq.length;
      let steps: (typeof seq.steps[number] | null)[] = [];
      for (let i = 0; i < srcLength; i++) {
        steps[i] = seq.steps[i];
      }
      let stepsCopy = JSON.parse(JSON.stringify(steps));
      switch (adjustment) {
        case 'double':
          seq.length = seq.length * 2;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[srcLength + i] = stepsCopy[i];
          }
          updateValuesForZone(zoneindex);
          toast('Sequence doubled');
          break;
        case 'halftime':
          seq.length = seq.length * 2;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[i * 2] = stepsCopy[i];
            if (seq.steps[i * 2]) {
              seq.steps[i * 2].length = seq.steps[i * 2].length * 2;
            }
            seq.steps[i * 2 + 1] = null;
          }
          updateValuesForZone(zoneindex);
          toast('Sequence made half time slower');
          break;
        case 'thirdtime':
          seq.length = seq.length * 3;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[i * 3] = stepsCopy[i];
            if (seq.steps[i * 3]) {
              seq.steps[i * 3].length = seq.steps[i * 3].length * 3;
            }
            seq.steps[i * 3 + 1] = seq.steps[i * 3 + 2] = null;
          }
          updateValuesForZone(zoneindex);
          toast('Sequence made one-third time slower');
          break;
        case 'veloup':
        case 'velodown':
          let factor = adjustment == 'veloup' ? 1 + 1 / 3 : 0.75;
          sequence.steps.forEach((step) => {
            if (step != null) {
              step.notesArray.forEach((note) => {
                const newvelo = note.velo * factor;
                note.velo = Math.max(1, Math.min(127, newvelo));
              });
            }
          });
          toast(
            'All steps changed velocity by ' + parseInt(String(factor * 100)) + '%'
          );
          updateValuesForZone(zoneindex);
          break;
      }
      setTimeout(() => {
        selectElement.selectedIndex = 0;
      }, 100);
    },
    seq_clear_step: () => {
      if (actionParam1 != 'undefined') {
        const stepno = parseInt(actionParam1);
        if (sequence.isDrumSequence) {
          const [laneIndex, stepIndex] =
            Sequence.getLaneAndStepIndexForDrumStepId(stepno);
          sequence.getDrumLane(laneIndex).steps[stepIndex] = null;
        } else {
          if (sequence.selectedStepNumbers.has(stepno)) {
            sequence.selectedStepNumbers.forEach((n) => {
              sequence.steps[n] = null;
            });
          } else {
            sequence.steps[stepno] = null;
          }
        }
        sequence.clearSelection();
        updateValuesForZone(zoneindex);
      }
    },
    seq_clear_selected_step: () => {
      if (sequence.selectedStepNumbers.size > 0) {
        sequence.selectedStepNumbers.forEach((n) => {
          if (sequence.isDrumSequence) {
            const [laneIndex, stepIndex] =
              Sequence.getLaneAndStepIndexForDrumStepId(n);
            sequence.getDrumLane(laneIndex).steps[stepIndex] = null;
          } else {
            sequence.steps[n] = null;
          }
        });
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_probability: () => {
      sequence.selectedStepNumbers.forEach((n) => {
        if (sequence.steps[n] != null) {
          sequence.steps[n].probability = calcAndDisplayPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_velocity: () => {
      if (sequence.selectedStep) {
        const velo = calcAndDisplayPercentage() * 127;
        sequence.selectedStep.notesArray.forEach((note) => {
          note.velo = Math.max(1, Math.min(127, velo));
        });
        updateValuesForZone(zoneindex);
      }
    },
    _seq_step_apply_to_all: (actionIndex?: number) => {
      const idx = actionIndex !== undefined ? actionIndex : parseInt(actionParam1);
      if (sequence.selectedStep && idx > 0) {
        let what = '';
        sequence.steps.forEach((s) => {
          if (s) {
            switch (idx) {
              case 1:
                s.length = sequence.selectedStep!.length;
                what = 'step length';
                break;
              case 2:
                s.gateLength = sequence.selectedStep!.gateLength;
                what = 'gate length';
                break;
              case 3:
                s.condition = sequence.selectedStep!.condition;
                what = 'trigger condition';
                break;
              case 4:
                s.probability = sequence.selectedStep!.probability;
                what = 'probability';
                break;
            }
          }
        });
        toast('Applied ' + what + ' to all steps in sequence');
        (element as HTMLSelectElement).selectedIndex = 0;
        updateValuesForZone(zoneindex);
      }
    },
    step_copy_length: () => {
      (actions._seq_step_apply_to_all as any)(1);
    },
    step_copy_gate: () => {
      (actions._seq_step_apply_to_all as any)(2);
    },
    step_copy_condition: () => {
      (actions._seq_step_apply_to_all as any)(3);
    },
    step_copy_chance: () => {
      (actions._seq_step_apply_to_all as any)(4);
    },
    seq_gatelength: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.gateLength = calcAndDisplayPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_copy_step: () => {
      if (actionParam1 != 'undefined') {
        const selStepIndex = parseInt(actionParam1);
        const stepsMap = new Map<number, any>();
        if (
          sequence.hasSelection &&
          sequence.selectedStepNumbers.has(selStepIndex)
        ) {
          const sortedIndexes = [...sequence.selectedStepNumbers].sort(
            (a, b) => a - b
          );
          const offset = sortedIndexes[0];
          sortedIndexes.forEach((stepindex) => {
            if (sequence.isStepUsed(stepindex)) {
              stepsMap.set(stepindex - offset, sequence.steps[stepindex]);
            }
          });
        } else {
          if (sequence.isStepUsed(selStepIndex)) {
            stepsMap.set(0, sequence.steps[selStepIndex]);
          }
        }
        Zone.seqClipboardStep = stepsMap;
      }
    },
    seq_paste_step: () => {
      if (actionParam1 != 'undefined' && Zone.seqClipboardStep) {
        sequence.clearSelection();
        const targetStep = parseInt(actionParam1);
        const targetSteps = sequence.steps;
        Array.from(Zone.seqClipboardStep.keys()).forEach((stepindex: number) => {
          targetSteps[(targetStep + stepindex) % sequence.length] =
            Sequence.cloneStep(Zone.seqClipboardStep!.get(stepindex));
        });
        updateValuesForZone(zoneindex);
      } else {
        toast('Nothing to paste, clipboard is empty.');
      }
    },
    seq_step_move: () => {
      if (sequence.hasSelection) {
        const direction = parseInt(actionParam1);
        const newSelection = new Set<number>();
        const sortedNumbers =
          direction < 0
            ? [...sequence.selectedStepNumbers].sort((a, b) => a - b)
            : [...sequence.selectedStepNumbers].sort((a, b) => a - b).reverse();
        sortedNumbers.forEach((stepnumber) => {
          if (sequence.isStepUsed(stepnumber)) {
            let newPos = (stepnumber + direction) % sequence.length;
            if (newPos < 0) {
              newPos = sequence.length - 1;
            }
            if (sequence.isStepEmpty(newPos)) {
              sequence.steps[newPos] = sequence.steps[stepnumber];
              sequence.steps[stepnumber] = null;
              newSelection.add(newPos);
            } else {
              newSelection.add(stepnumber);
            }
          }
        });
        sequence.selectedStepNumbers = newSelection;
        updateValuesForZone(zoneindex);
      }
    },
    seq_move: () => {
      sequence.clearSelection();
      const direction = parseInt(actionParam1);
      const limit = sequence.length;
      const newSeq: (typeof sequence.steps[number] | null)[] = [];
      for (let i = 0; i < Sequence.MAX_STEPS; i++) {
        newSeq[i] = sequence.steps[i];
      }
      const srcOffset = direction > 0 ? limit - 1 : 1;
      for (let i = 0; i < limit; i++) {
        newSeq[i] = sequence.steps[(i + srcOffset) % limit];
      }
      sequence.steps = newSeq;
      updateValuesForZone(zoneindex);
    },
    seq_copy: () => {
      const copyData = {
        steps: sequence.steps,
        length: sequence.length,
        division: sequence.division
      };
      Zone.seqClipboardSequence = JSON.stringify(copyData);
      toast('Sequence copied to clipboard');
    },
    seq_paste: () => {
      if (Zone.seqClipboardSequence) {
        const copyData = JSON.parse(Zone.seqClipboardSequence);
        Object.assign(sequence, copyData);
        updateValuesForZone(zoneindex);
        toast('Sequence pasted from clipboard');
      } else {
        toast('Clipboard is empty, nothing to paste');
      }
    },
    seq_copy_to_layer_0: () => {
      const targetLayer = parseInt(actionParam1);
      const copyData = JSON.parse(
        JSON.stringify({
          steps: sequence.steps,
          length: sequence.length,
          division: sequence.division,
          ticks: sequence.ticks
        })
      );
      Object.assign(sequence.layers[targetLayer], copyData);
      updateValuesForZone(zoneindex);
      toast(
        'Sequence duplicated to layer ' + String.fromCharCode(65 + targetLayer)
      );
    },
    seq_copy_to_layer_1: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_copy_to_layer_2: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_copy_to_layer_3: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_step_condition: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.condition = (element as HTMLSelectElement).selectedIndex;
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_add_notes: () => {
      sequence.stepAddNotes = !sequence.stepAddNotes;
      updateValuesForZone(zoneindex);
    },
    seq_step_advance: () => {
      sequence.stepAdvance = !sequence.stepAdvance;
      updateValuesForZone(zoneindex);
    },
    seq_record_live: () => {
      sequence.clearSelection();
      sequence.isLiveRecoding = !sequence.isLiveRecoding;
      updateValuesForZone(zoneindex);
      toast(
        sequence.isLiveRecoding
          ? 'Live recording enabled!'
          : 'Stopped live recording'
      );
    },
    seq_drum_tracks: () => {
      sequence.clearSelection();
      sequence.isDrumSequence = !sequence.isDrumSequence;
      updateValuesForZone(zoneindex);
      toast(
        sequence.isDrumSequence ? 'Drum sequence mode' : 'Note sequence mode'
      );
    }
  };

  return actions;
}
