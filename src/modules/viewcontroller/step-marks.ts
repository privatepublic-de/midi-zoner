import { Note } from '../zone/note';
import { SeqStep } from '../zone/seq-step';

/**
 * Puts a step's properties on a step cell or piano roll note for the CSS to draw:
 * `--velo` velocity, `data-chance` chance < 100%, `data-cond` a play condition,
 * `--rc` / `--rc-pitch` ratchet ticks, `data-locks` parameter locks (`only` without
 * notes). Sets a tooltip listing them.
 */
export function showStepProperties(el: HTMLElement, step: SeqStep | null): void {
  const notes = step?.notesArray ?? [];
  const locks = step?.locks.length ?? 0;
  if (locks > 0) el.dataset.locks = notes.length === 0 ? 'only' : '';
  else delete el.dataset.locks;
  if (!step || notes.length === 0) {
    el.style.removeProperty('--velo');
    el.style.removeProperty('--rc');
    el.style.removeProperty('--rc-pitch');
    delete el.dataset.chance;
    delete el.dataset.cond;
    delete el.dataset.rc;
    if (locks > 0) el.title = lockDetail(step!);
    else el.removeAttribute('title');
    return;
  }
  const velo = notes.reduce((sum, n) => sum + n.velo, 0) / notes.length;
  el.style.setProperty('--velo', (velo / 127).toFixed(3));
  const rc = step.ratchetCount ?? 1;
  if (rc > 1) {
    el.dataset.rc = String(rc);
    el.style.setProperty('--rc', String(rc));
    // whole-pixel tick pitch keeps ticks crisp: 2px tick + gap up to 5, 1px + gap above
    el.style.setProperty('--rc-pitch', rc <= 5 ? '3px' : '2px');
  } else {
    delete el.dataset.rc;
    el.style.removeProperty('--rc');
    el.style.removeProperty('--rc-pitch');
  }
  if (step.probability < 1) el.dataset.chance = '';
  else delete el.dataset.chance;
  if (step.condition > 0) el.dataset.cond = '';
  else delete el.dataset.cond;
  el.title = [
    notes.map((n) => Note.display(n.number)).join(' '),
    velocityLabel(velo),
    ...stepDetails(step)
  ].join(', ');
}

export function velocityLabel(velo: number): string {
  return `velocity ${Math.trunc((velo / 127) * 100)}%`;
}

/** Tooltip parts for a step's settings that differ from the defaults. */
export function stepDetails(step: SeqStep): string[] {
  const details: string[] = [];
  if (step.probability < 1) details.push(`chance ${Math.round(step.probability * 100)}%`);
  if (step.condition > 0) details.push('has a play condition');
  if ((step.ratchetCount ?? 1) > 1) details.push(`ratchet ×${step.ratchetCount}`);
  if (step.length > 1) details.push(`length ${step.length}`);
  if (step.locks.length > 0) details.push(lockDetail(step));
  return details;
}

function lockDetail(step: SeqStep): string {
  const n = step.locks.length;
  return `${n} parameter lock${n > 1 ? 's' : ''}${step.slide ? ' (slide)' : ''}`;
}
