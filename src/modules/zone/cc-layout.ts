import { CCController, CCControllerType } from './interfaces';

/**
 * Pages and sections structure a zone's controllers. A PAGE entry starts a page: the zone
 * shows one page at a time. A SECTION entry starts a group (normally on a new row) and
 * gives the controllers after it their colour, up to the next section or page.
 */

export function isSection(c: CCController | undefined): boolean {
  return c?.type == CCControllerType.SECTION;
}

export function isPage(c: CCController | undefined): boolean {
  return c?.type == CCControllerType.PAGE;
}

/** Index of the section a controller belongs to, -1 if none (sections end at a page) */
export function sectionIndexOf(controllers: CCController[], ix: number): number {
  for (let i = ix; i >= 0; i--) {
    if (isSection(controllers[i])) return i;
    if (isPage(controllers[i])) return -1;
  }
  return -1;
}

export interface PageBlock {
  /** Index of the page entry, -1 for the controllers before the first page */
  page: number;
  /** The page's entries: [start, end) */
  start: number;
  end: number;
}

/** The pages; controllers before the first PAGE entry form a page of their own */
export function pageBlocks(controllers: CCController[]): PageBlock[] {
  const pages: PageBlock[] = [];
  let current: PageBlock = { page: -1, start: 0, end: controllers.length };
  controllers.forEach((c, ix) => {
    if (!isPage(c)) return;
    current.end = ix;
    if (current.page >= 0 || ix > 0) pages.push(current);
    current = { page: ix, start: ix + 1, end: controllers.length };
  });
  pages.push(current);
  return pages;
}

export function pageName(controllers: CCController[], pages: PageBlock[], n: number): string {
  const page = pages[n];
  if (!page || page.page < 0) return 'Main';
  return controllers[page.page].label.trim() || `Page ${n + 1}`;
}

/** The number of the page an entry is on (a page entry is on its own page) */
export function pageNumberOf(controllers: CCController[], ix: number): number {
  const pages = pageBlocks(controllers);
  const n = pages.findIndex((p) => ix < p.end);
  return n < 0 ? pages.length - 1 : n;
}

export function newPage(label: string): CCController {
  return { ...newSection(label, 0), type: CCControllerType.PAGE };
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

/** The sections of the entries [start, end) (all by default); pages are boundaries */
export function sectionBlocks(controllers: CCController[], start = 0, end = controllers.length): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  let current: SectionBlock | null = null;
  for (let ix = start; ix < end; ix++) {
    const c = controllers[ix];
    if (isPage(c)) {
      current = null;
    } else if (isSection(c)) {
      current = { section: ix, items: [] };
      blocks.push(current);
    } else {
      if (!current) {
        current = { section: -1, items: [] };
        blocks.push(current);
      }
      current.items.push(ix);
    }
  }
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
  // Sections and pages only exist in the new format
  if (controllers.some((c) => isSection(c) || isPage(c)) || !controllers.some((c) => c.type == CCControllerType.SPACER)) {
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
