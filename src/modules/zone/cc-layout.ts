import { CCController, CCControllerType } from './interfaces';

/**
 * Sections structure a zone's controllers: a SECTION entry starts a group (normally on a
 * new row) and gives the controllers after it their colour, up to the next section.
 */

export function isSection(c: CCController | undefined): boolean {
  return c?.type == CCControllerType.SECTION;
}

/** Index of the section a controller belongs to, -1 before the first section */
export function sectionIndexOf(controllers: CCController[], ix: number): number {
  for (let i = ix; i >= 0; i--) {
    if (isSection(controllers[i])) return i;
  }
  return -1;
}

/** The controller's colour: its own override, else its section's */
export function effectiveGroup(controllers: CCController[], ix: number): number {
  const c = controllers[ix];
  if (isSection(c) || c.group) return c.group || 0;
  const section = sectionIndexOf(controllers, ix);
  return section >= 0 ? controllers[section].group || 0 : 0;
}

export interface SectionBlock {
  /** Index of the section entry, -1 for the controllers before the first section */
  section: number;
  /** Indices of its controllers */
  items: number[];
}

export function sectionBlocks(controllers: CCController[]): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  let current: SectionBlock | null = null;
  controllers.forEach((c, ix) => {
    if (isSection(c)) {
      current = { section: ix, items: [] };
      blocks.push(current);
    } else {
      if (!current) {
        current = { section: -1, items: [] };
        blocks.push(current);
      }
      current.items.push(ix);
    }
  });
  return blocks;
}

// The old layout: a flex row of 536px, knobs 64px wide, spacers 32px
const OLD_ROW_WIDTH = 536;
const OLD_KNOB_WIDTH = 64;
const OLD_SPACER_WIDTH = 32;

/**
 * Lists from before sections used runs of spacers to push the next controller onto a new
 * row. Such runs become unnamed section breaks; spacers inside a row stay as gaps and
 * trailing ones are dropped. Lists that already have sections are left alone.
 */
export function migrateSpacers(controllers: CCController[]): CCController[] {
  if (controllers.some(isSection) || !controllers.some((c) => c.type == CCControllerType.SPACER)) {
    return controllers;
  }
  const result: CCController[] = [];
  let x = 0;
  let row = 0;
  const place = (w: number): void => {
    if (x > 0 && x + w > OLD_ROW_WIDTH) {
      x = 0;
      row++;
    }
    x += w;
  };
  let i = 0;
  while (i < controllers.length) {
    const c = controllers[i];
    if (c.type != CCControllerType.SPACER) {
      place(OLD_KNOB_WIDTH);
      result.push(c);
      i++;
      continue;
    }
    let end = i;
    while (end < controllers.length && controllers[end].type == CCControllerType.SPACER) end++;
    if (end == controllers.length) break; // trailing spacers do nothing
    const startX = x;
    const startRow = row;
    for (let k = i; k < end; k++) place(OLD_SPACER_WIDTH);
    // The next controller lands on a later row because of the run (spacers that spill
    // into the new row were overshoot): a row break
    const nextRow = x > 0 && x + OLD_KNOB_WIDTH > OLD_ROW_WIDTH ? row + 1 : row;
    const wrapsAnyway = startX > 0 && startX + OLD_KNOB_WIDTH > OLD_ROW_WIDTH;
    if (nextRow > startRow && !wrapsAnyway) {
      result.push(newSection('', 0));
      x = 0;
      row = startRow + 1;
    } else {
      result.push(...controllers.slice(i, end));
    }
    i = end;
  }
  return result;
}

export function newSection(label: string, group: number): CCController {
  return {
    type: CCControllerType.SECTION,
    label,
    group,
    number: 0,
    number_in: null,
    val: 0,
    min: 0,
    max: 127,
    note_cc: null,
    velocity_cc: null
  };
}
