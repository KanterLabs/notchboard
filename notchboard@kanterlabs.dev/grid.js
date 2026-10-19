// Kept independent of Shell so spatial rules can be tested directly.
export const COLUMNS = 3;
export const MAX_CELLS = 36;

export function neighbor(index, direction, count) {
    const row = Math.floor(index / COLUMNS);
    const col = index % COLUMNS;
    const delta = {left: -1, right: 1, up: -COLUMNS, down: COLUMNS}[direction];
    if (delta === undefined || (direction === 'left' && col === 0) ||
        (direction === 'right' && col === COLUMNS - 1) ||
        (direction === 'up' && row === 0))
        return index;
    const next = index + delta;
    return next >= 0 && next < count ? next : index;
}

export function nearestEmpty(origin, occupied, count) {
    const distance = i => Math.abs(Math.floor(i / COLUMNS) - Math.floor(origin / COLUMNS)) +
        Math.abs(i % COLUMNS - origin % COLUMNS);
    return Array.from({length: count}, (_, i) => i)
        .filter(i => !occupied.has(i))
        .sort((a, b) => distance(a) - distance(b) || a - b)[0] ?? -1;
}

export function capacity(highestIndex, minimum = 6) {
    return Math.min(MAX_CELLS, Math.max(minimum,
        Math.ceil((highestIndex + 2) / COLUMNS) * COLUMNS));
}

export function isGridShortcut(accel) {
    const parts = accel.toLowerCase().match(/<[^>]+>|[^<>]+/g) ?? [];
    return ['left', 'right', 'up', 'down'].includes(parts.at(-1)) &&
        parts.includes('<super>') &&
        parts.every(p => ['<super>', '<shift>', 'left', 'right', 'up', 'down'].includes(p));
}
