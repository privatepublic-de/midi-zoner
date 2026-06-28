import { Zone } from '../../zone/zone-class';
import { Sequence } from '../../zone/sequence';
import { SeqStep } from '../../zone/seq-step';
import { ActionContext, ActionHelpers, ActionMap } from '../types';

const RATCHET_RES_LABELS: Record<number, string> = {
  48: '1/2', 36: '1/4.', 32: '1/2T', 24: '1/4', 18: '1/8.',
  16: '1/4T', 12: '1/8', 9: '1/16.', 8: '1/8T', 6: '1/16',
  4: '1/16T', 3: '1/32', 2: '1/32T', 1: '1tk'
};

export function ratchetResToLabel(ticks: number): string {
  return RATCHET_RES_LABELS[ticks] ?? `${ticks}tk`;
}

export function createSeqActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const {
    zone,
    zoneindex,
    sequence,
    element,
    actionParam1,
    actionParam2,
    ev,
    updateValuesForZone,
    toast
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
      sequence.getDrumLane(laneNo).note = parseInt(
        (element as HTMLInputElement).value
      );
      updateValuesForZone(zoneindex);
    },
    seq_drum_lane_label: () => {
      const laneNo = parseInt(actionParam1);
      sequence.getDrumLane(laneNo).label = (element as HTMLInputElement).value.slice(0, 5);
    },
    seq_toggle_lanes_expand: () => {
      document.getElementById(`zone${zoneindex}`)?.classList.toggle('lanes-expanded');
    },
    seq_drum_lane_steps: () => {
      const laneNo = parseInt(actionParam1);
      const v = Math.max(1, Math.min(Sequence.MAX_STEPS_DRUMS, parseInt((element as HTMLInputElement).value)));
      const lane = sequence.getDrumLane(laneNo);
      lane.length = v;
      lane.currentStep = -1;
      lane.previousStep = -1;
      lane.previousStepPlayed = false;
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
    seq_toggle_lane_solo: () => {
      const laneNo = parseInt(actionParam1);
      const dl = sequence.getDrumLane(laneNo);
      dl.solo = !dl.solo;
      updateValuesForZone(zoneindex);
    },
    seq_toggle_lane_euclid: () => {
      const laneNo = parseInt(actionParam1);
      const laneEl = zone.elements.get(`.lane${laneNo}`);
      const eucPanel = zone.elements.get(`.lane${laneNo} .euc-panel`) as HTMLElement | null;
      if (!eucPanel || !laneEl) return;
      const isOpen = eucPanel.style.display === 'flex';
      if (isOpen) {
        eucPanel.style.display = 'none';
        laneEl.classList.remove('euc-open');
      } else {
        document.querySelectorAll('.euc-panel').forEach((p) => {
          (p as HTMLElement).style.display = 'none';
          p.closest('.drum-lane')?.classList.remove('euc-open');
        });
        const hitsInput = eucPanel.querySelector('.euc-hits') as HTMLInputElement | null;
        if (hitsInput) {
          const laneLen = sequence.getDrumLane(laneNo).length;
          hitsInput.max = String(laneLen);
          hitsInput.value = String(Math.min(parseInt(hitsInput.value), laneLen));
          const valDisplay = eucPanel.querySelector('.euc-val') as HTMLElement | null;
          if (valDisplay) valDisplay.textContent = hitsInput.value;
        }
        eucPanel.style.display = 'flex';
        laneEl.classList.add('euc-open');
      }
    },
    seq_euclid_lane: () => {
      const laneNo = parseInt(actionParam1);
      const hitsInput = zone.elements.get(
        `.lane${laneNo} .euc-hits`
      ) as HTMLInputElement | null;
      const hits = hitsInput ? parseInt(hitsInput.value) : 4;
      const valDisplay = zone.elements.get(`.lane${laneNo} .euc-val`) as HTMLElement | null;
      if (valDisplay) valDisplay.textContent = String(hits);
      sequence.fillDrumLaneEuclidean(laneNo, hits);
      updateValuesForZone(zoneindex);
    },
    seq_copy_lane: () => {
      const laneNo = parseInt(actionParam1);
      const lane = sequence.getDrumLane(laneNo);
      const steps = [];
      for (let i = 0; i < lane.length; i++) {
        steps.push(lane.steps[i] ? JSON.parse(JSON.stringify(lane.steps[i])) : null);
      }
      Zone.seqClipboardDrumLane = { steps, length: lane.length };
      toast('Lane pattern copied');
    },
    seq_paste_lane: () => {
      if (!Zone.seqClipboardDrumLane) {
        toast('Clipboard is empty, nothing to paste');
        return;
      }
      const laneNo = parseInt(actionParam1);
      const lane = sequence.getDrumLane(laneNo);
      const src = Zone.seqClipboardDrumLane;
      for (let i = 0; i < lane.length; i++) {
        const srcStep = src.steps[i % src.length];
        if (srcStep) {
          const copied = JSON.parse(JSON.stringify(srcStep));
          copied.lastPlayedArray = [];
          lane.steps[i] = copied;
        } else {
          lane.steps[i] = null;
        }
      }
      updateValuesForZone(zoneindex);
      toast('Lane pattern pasted');
    },
    seq_clear_lane: () => {
      const laneNo = parseInt(actionParam1);
      const lane = sequence.getDrumLane(laneNo);
      lane.steps.length = 0;
      updateValuesForZone(zoneindex);
      toast('Lane cleared');
    },
    seq_step_length: () => {
      const v = parseInt((element as HTMLInputElement).value);
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.length = v;
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_clear_all: () => {
      if (sequence.isDrumSequence) {
        for (let i = 0; i < sequence.drumLanes; i++) {
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
      const semitones = parseInt(
        selectElement.options[selectElement.selectedIndex].value
      );
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
      const adjustment =
        selectElement.options[selectElement.selectedIndex].value;
      const seq = sequence;
      const srcLength = seq.length;
      if (seq.isDrumSequence) {
        switch (adjustment) {
          case 'double':
          case 'halftime':
          case 'thirdtime': {
            const multiplier = adjustment === 'thirdtime' ? 3 : 2;
            for (let ln = 0; ln < seq.drumLanes; ln++) {
              const lane = seq.getDrumLane(ln);
              const laneLen = lane.length;
              const newLen = Math.min(Sequence.MAX_STEPS_DRUMS, laneLen * multiplier);
              const copy: (SeqStep | null)[] = [];
              for (let i = 0; i < laneLen; i++) {
                copy[i] = lane.steps[i] ? JSON.parse(JSON.stringify(lane.steps[i])) : null;
              }
              if (adjustment === 'double') {
                for (let i = 0; i < laneLen && laneLen + i < newLen; i++) {
                  lane.steps[laneLen + i] = copy[i];
                }
              } else {
                for (let i = 0; i < laneLen; i++) {
                  const pos = i * multiplier;
                  if (pos < newLen) {
                    lane.steps[pos] = copy[i];
                    if (lane.steps[pos]) lane.steps[pos]!.length = lane.steps[pos]!.length * multiplier;
                  }
                  for (let k = 1; k < multiplier; k++) {
                    if (pos + k < newLen) lane.steps[pos + k] = null;
                  }
                }
              }
              lane.length = newLen;
              lane.currentStep = -1;
              lane.previousStep = -1;
              lane.previousStepPlayed = false;
            }
            const label = adjustment === 'double' ? 'doubled' : adjustment === 'halftime' ? 'half time' : 'one-third time';
            toast(`Drum lanes ${label}`);
            break;
          }
          case 'veloup':
          case 'velodown': {
            const factor = adjustment === 'veloup' ? 1 + 1 / 3 : 0.75;
            for (let ln = 0; ln < seq.drumLanes; ln++) {
              seq.getDrumLane(ln).steps.forEach((step) => {
                if (step) {
                  step.notesArray.forEach((note) => {
                    note.velo = Math.max(1, Math.min(127, note.velo * factor));
                  });
                }
              });
            }
            toast('Drum steps changed velocity by ' + parseInt(String(factor * 100)) + '%');
            break;
          }
        }
        updateValuesForZone(zoneindex);
      } else {
        const steps: ((typeof seq.steps)[number] | null)[] = [];
        for (let i = 0; i < srcLength; i++) {
          steps[i] = seq.steps[i];
        }
        const stepsCopy = JSON.parse(JSON.stringify(steps));
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
          case 'velodown': {
            const factor = adjustment === 'veloup' ? 1 + 1 / 3 : 0.75;
            sequence.steps.forEach((step) => {
              if (step != null) {
                step.notesArray.forEach((note) => {
                  const newvelo = note.velo * factor;
                  note.velo = Math.max(1, Math.min(127, newvelo));
                });
              }
            });
            toast('All steps changed velocity by ' + parseInt(String(factor * 100)) + '%');
            updateValuesForZone(zoneindex);
            break;
          }
          case 'euclid-distrib': {
            const euclidPositions = (hits: number, length: number): number[] => {
              const positions: number[] = [];
              const s = hits / length;
              let previous = -1;
              for (let i = 0; i < length; i++) {
                const current = Math.floor(i * s);
                if (current !== previous) positions.push(i);
                previous = current;
              }
              return positions;
            };
            if (seq.hasSelection) {
              const sortedSelected = [...seq.selectedStepNumbers].sort((a, b) => a - b);
              const firstPos = sortedSelected[0];
              const lastPos = sortedSelected[sortedSelected.length - 1];
              const span = lastPos - firstPos + 1;
              const hitSteps = sortedSelected
                .map(i => seq.steps[i])
                .filter((s): s is SeqStep => s != null && s.notesArray.length > 0);
              if (hitSteps.length > 0) {
                const positions = euclidPositions(hitSteps.length, span);
                for (let i = firstPos; i <= lastPos; i++) seq.steps[i] = null;
                hitSteps.forEach((step, h) => { seq.steps[firstPos + positions[h]] = step; });
                seq.selectedStepNumbers.clear();
                positions.forEach(p => seq.selectedStepNumbers.add(firstPos + p));
                toast('Selected steps euclidean distributed');
                updateValuesForZone(zoneindex);
              }
            } else {
              const hitSteps: SeqStep[] = [];
              for (let i = 0; i < srcLength; i++) {
                if (seq.steps[i] != null && seq.steps[i]!.notesArray.length > 0) {
                  hitSteps.push(seq.steps[i]!);
                }
              }
              if (hitSteps.length > 0) {
                const positions = euclidPositions(hitSteps.length, srcLength);
                for (let i = 0; i < srcLength; i++) seq.steps[i] = null;
                hitSteps.forEach((step, h) => { seq.steps[positions[h]] = step; });
                toast('Sequence euclidean distributed');
                updateValuesForZone(zoneindex);
              }
            }
            break;
          }
        }
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
          toast('Step cleared');
        } else {
          if (sequence.selectedStepNumbers.has(stepno)) {
            const count = sequence.selectedStepNumbers.size;
            sequence.selectedStepNumbers.forEach((n) => {
              sequence.steps[n] = null;
            });
            toast(count === 1 ? 'Step cleared' : `${count} steps cleared`);
          } else {
            sequence.steps[stepno] = null;
            toast('Step cleared');
          }
        }
        sequence.clearSelection();
        updateValuesForZone(zoneindex);
      }
    },
    seq_clear_selected_step: () => {
      if (sequence.selectedStepNumbers.size > 0) {
        const count = sequence.selectedStepNumbers.size;
        sequence.selectedStepNumbers.forEach((n) => {
          if (sequence.isDrumSequence) {
            const [laneIndex, stepIndex] =
              Sequence.getLaneAndStepIndexForDrumStepId(n);
            sequence.getDrumLane(laneIndex).steps[stepIndex] = null;
          } else {
            sequence.steps[n] = null;
          }
        });
        toast(count === 1 ? 'Step cleared' : `${count} steps cleared`);
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_probability: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.probability = calcAndDisplayPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_velocity: () => {
      const velo = calcAndDisplayPercentage() * 127;
      sequence.selectedSteps.forEach((step) => {
        step?.notesArray.forEach((note) => {
          note.velo = Math.max(1, Math.min(127, velo));
        });
      });
    },
    _seq_step_apply_to_all: (actionIndex?: number) => {
      const idx =
        actionIndex !== undefined ? actionIndex : parseInt(actionParam1);
      const allSteps = sequence.isDrumSequence
        ? sequence.drumSteps
        : sequence.steps;
      if (sequence.selectedStep && idx > 0) {
        let what = '';
        allSteps.forEach((s) => {
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
    seq_step_ratchet_count: () => {
      const v = Math.max(1, parseInt((element as HTMLSelectElement).value) || 1);
      sequence.selectedSteps.forEach((step) => {
        if (step) step.ratchetCount = v;
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_ratchet_res: () => {
      const v = parseInt((element as HTMLInputElement).value);
      const out = (element as HTMLInputElement).parentElement?.querySelector(
        `output[for="${(element as HTMLInputElement).id}"]`
      ) as HTMLOutputElement | null;
      if (out) out.value = ratchetResToLabel(v);
      sequence.selectedSteps.forEach((step) => {
        if (step) step.ratchetResolution = v;
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_ratchet_delta: () => {
      const v = parseInt((element as HTMLInputElement).value) || 0;
      sequence.selectedSteps.forEach((step) => {
        if (step) step.ratchetVelocityDelta = v;
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
              if (sequence.isDrumSequence) {
                const [laneIndex, stepIdx] = Sequence.getLaneAndStepIndexForDrumStepId(stepindex);
                stepsMap.set(stepindex - offset, sequence.getDrumLane(laneIndex).steps[stepIdx]);
              } else {
                stepsMap.set(stepindex - offset, sequence.steps[stepindex]);
              }
            }
          });
        } else {
          if (sequence.isStepUsed(selStepIndex)) {
            if (sequence.isDrumSequence) {
              const [laneIndex, stepIdx] = Sequence.getLaneAndStepIndexForDrumStepId(selStepIndex);
              stepsMap.set(0, sequence.getDrumLane(laneIndex).steps[stepIdx]);
            } else {
              stepsMap.set(0, sequence.steps[selStepIndex]);
            }
          }
        }
        Zone.seqClipboardStep = stepsMap;
        if (stepsMap.size > 0) {
          toast(stepsMap.size === 1 ? 'Step copied' : `${stepsMap.size} steps copied`);
        }
      }
    },
    seq_paste_step: () => {
      if (actionParam1 != 'undefined' && Zone.seqClipboardStep) {
        sequence.clearSelection();
        const targetStep = parseInt(actionParam1);
        const count = Zone.seqClipboardStep.size;
        if (sequence.isDrumSequence) {
          const [targetLaneIndex, targetStepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(targetStep);
          const targetLane = sequence.getDrumLane(targetLaneIndex);
          Array.from(Zone.seqClipboardStep.keys()).forEach(
            (stepindex: number) => {
              const newStepIndex = (targetStepIndex + stepindex) % targetLane.length;
              targetLane.steps[newStepIndex] = Sequence.cloneStep(Zone.seqClipboardStep!.get(stepindex));
            }
          );
        } else {
          const targetSteps = sequence.steps;
          Array.from(Zone.seqClipboardStep.keys()).forEach(
            (stepindex: number) => {
              targetSteps[(targetStep + stepindex) % sequence.length] =
                Sequence.cloneStep(Zone.seqClipboardStep!.get(stepindex));
            }
          );
        }
        updateValuesForZone(zoneindex);
        toast(count === 1 ? 'Step pasted' : `${count} steps pasted`);
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
            if (sequence.isDrumSequence) {
              // Drum mode: stepnumber is a drum step ID
              const [laneIndex, stepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(stepnumber);
              const lane = sequence.getDrumLane(laneIndex);
              let newStepIndex = (stepIndex + direction) % lane.length;
              if (newStepIndex < 0) {
                newStepIndex = lane.length - 1;
              }
              if (lane.steps[newStepIndex] == null) {
                lane.steps[newStepIndex] = lane.steps[stepIndex];
                lane.steps[stepIndex] = null;
                newSelection.add(Sequence.getIdForDrumStep(laneIndex, newStepIndex));
              } else {
                newSelection.add(stepnumber);
              }
            } else {
              // Regular mode: stepnumber is a simple index
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
          }
        });
        sequence.selectedStepNumbers = newSelection;
        updateValuesForZone(zoneindex);
      }
    },
    seq_move: () => {
      sequence.clearSelection();
      const direction = parseInt(actionParam1);
      
      if (sequence.isDrumSequence) {
        // Drum mode: shift all enabled lanes
        for (let ln = 0; ln < sequence.drumLanes; ln++) {
          const lane = sequence.getDrumLane(ln);
          if (lane.enabled) {
            const length = lane.length;
            const newSteps: (SeqStep | null)[] = new Array(length).fill(null);
            for (let i = 0; i < length; i++) {
              const srcIndex = (i - direction + length) % length;
              newSteps[i] = lane.steps[srcIndex];
            }
            lane.steps = newSteps;
          }
        }
      } else {
        // Regular mode: shift steps array
        const limit = sequence.length;
        const newSeq: ((typeof sequence.steps)[number] | null)[] = [];
        for (let i = 0; i < Sequence.MAX_STEPS; i++) {
          newSeq[i] = sequence.steps[i];
        }
        const srcOffset = direction > 0 ? limit - 1 : 1;
        for (let i = 0; i < limit; i++) {
          newSeq[i] = sequence.steps[(i + srcOffset) % limit];
        }
        sequence.steps = newSeq;
      }
      toast('Sequence shifted');
      updateValuesForZone(zoneindex);
    },
    seq_copy: () => {
      if (sequence.isDrumSequence) {
        const drum_lanes_copy = [];
        for (let ln = 0; ln < sequence.drumLanes; ln++) {
          const lane = sequence.getDrumLane(ln);
          drum_lanes_copy.push(JSON.parse(JSON.stringify(lane)));
        }
        Zone.seqClipboardSequence = JSON.stringify({
          isDrumSequence: true,
          drum_lanes: drum_lanes_copy,
          drumLanes: sequence.drumLanes,
          length: sequence.length,
          division: sequence.division
        });
      } else {
        Zone.seqClipboardSequence = JSON.stringify({
          isDrumSequence: false,
          steps: sequence.steps,
          length: sequence.length,
          division: sequence.division
        });
      }
      toast('Sequence copied to clipboard');
    },
    seq_paste: () => {
      if (Zone.seqClipboardSequence) {
        const copyData = JSON.parse(Zone.seqClipboardSequence);
        if (copyData.isDrumSequence && sequence.isDrumSequence) {
          sequence.drum_lanes = copyData.drum_lanes || [];
          sequence.drumLanes = copyData.drumLanes ?? sequence.drumLanes;
          sequence.length = copyData.length;
          sequence.division = copyData.division;
          sequence.drum_lanes.forEach((lane: any) => {
            if (lane?.steps) {
              lane.steps.forEach((st: any) => { if (st) st.lastPlayedArray = []; });
            }
            lane.previousStepPlayed = false;
          });
        } else if (!copyData.isDrumSequence && !sequence.isDrumSequence) {
          Object.assign(sequence, copyData);
        } else {
          toast('Cannot paste: clipboard contains a different sequence type');
          return;
        }
        updateValuesForZone(zoneindex);
        toast('Sequence pasted from clipboard');
      } else {
        toast('Clipboard is empty, nothing to paste');
      }
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
    },
    seq_drumlane_move: () => {
      const laneIndex = parseInt(actionParam1);
      const direction = parseInt(actionParam2);
      const lane = sequence.getDrumLane(laneIndex);
      const length = lane.length;
      const newSteps: (SeqStep | null)[] = new Array(length).fill(null);
      
      for (let i = 0; i < length; i++) {
        const srcIndex = (i - direction + length) % length;
        newSteps[i] = lane.steps[srcIndex];
      }
      
      lane.steps = newSteps;
      sequence.clearSelection();
      toast('Lane shifted');
      updateValuesForZone(zoneindex);
    }
  };

  return actions;
}
