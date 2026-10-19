import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../notchboard@kanterlabs.dev/grid.js', import.meta.url), 'utf8');
const {neighbor, nearestEmpty, capacity, isGridShortcut} = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('arrows preserve spatial neighbors, never wrap or leave the grid', () => {
    for (let count = 6; count <= 36; count += 3) {
        for (let i = 0; i < count; i++) {
            for (const direction of ['left', 'right', 'up', 'down']) {
                const next = neighbor(i, direction, count);
                assert.ok(next >= 0 && next < count);
                if (next !== i) {
                    const opposite = {left: 'right', right: 'left', up: 'down', down: 'up'}[direction];
                    assert.equal(neighbor(next, opposite, count), i);
                    if (['left', 'right'].includes(direction))
                        assert.equal(Math.floor(next / 3), Math.floor(i / 3));
                }
            }
        }
    }
    assert.equal(neighbor(2, 'right', 6), 2);
    assert.equal(neighbor(3, 'left', 6), 3);
    assert.equal(neighbor(1, 'down', 6), 4);
});

test('new windows reuse the nearest hole with stable tie breaking', () => {
    assert.equal(nearestEmpty(4, new Set([1, 3, 4, 5]), 9), 7);
    assert.equal(nearestEmpty(0, new Set([0]), 6), 1);
    assert.equal(nearestEmpty(2, new Set([0, 1, 2, 3, 4, 5]), 6), -1);
    assert.equal(nearestEmpty(4, new Set([0, 1]), 6), 4);
});

test('capacity grows in full rows with a spare cell and a safe 36-cell ceiling', () => {
    assert.equal(capacity(0), 6);
    assert.equal(capacity(5), 9);
    assert.equal(capacity(2, 12), 12);
    assert.equal(capacity(35), 36);
});

test('shortcut takeover preserves unrelated bindings and modifier combinations', () => {
    for (const key of ['<Super>Left', '<Shift><Super>Right', '<Super><Shift>Up', '<super>Down'])
        assert.equal(isGridShortcut(key), true, key);
    for (const key of ['<Super><Alt>Left', '<Control><Super>Right', '<Super>KP_4', '<Super>w', '<Alt>Left'])
        assert.equal(isGridShortcut(key), false, key);
});
