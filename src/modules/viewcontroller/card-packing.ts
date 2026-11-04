// Cards packed in columns (styles.css, #zones): the container is a grid of 1px rows and
// each card spans as many rows as it is tall plus the gap, so a short card no longer
// leaves a hole beside a tall one. Grid auto-placement keeps the zone order and puts
// each card at the first place with room, in practice the column that ends first.
// The span goes into --card-rows, which only the cards layout reads (the mini view and
// the track view lay out the same elements their own way).

const CARD_GAP = 5;

function setRows(card: HTMLElement): void {
  const rows = String(card.offsetHeight + CARD_GAP);
  if (card.style.getPropertyValue('--card-rows') !== rows) card.style.setProperty('--card-rows', rows);
}

export function initCardPacking(container: HTMLElement): void {
  const resized = new ResizeObserver((entries) => {
    for (const entry of entries) setRows(entry.target as HTMLElement);
  });
  const watch = (node: Node) => {
    if (node instanceof HTMLElement) resized.observe(node);
  };
  container.childNodes.forEach(watch);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(watch);
      m.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement) resized.unobserve(node);
      });
    }
  }).observe(container, { childList: true });
}
