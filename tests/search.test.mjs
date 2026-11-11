import test from 'node:test';
import assert from 'node:assert/strict';
import {matchScore, calculate, formatNumber, webTarget} from '../notchboard@kanterlabs.dev/search.js';
import {sameShortcut} from '../notchboard@kanterlabs.dev/grid.js';

test('better matches score higher, and every word has to match', () => {
    const score = query => matchScore(query, 'Visual Studio Code', 'editor ide programming');
    assert.ok(score('visual studio code') > score('vis'));
    assert.ok(score('vis') > score('studio'));
    assert.ok(score('studio') > score('vsc'));
    assert.ok(score('vsc') > score('tudio'));
    assert.ok(score('tudio') > score('edit'));
    assert.ok(score('edit') > score('gramm'));
    assert.ok(score('gramm') > 0);
    assert.equal(score('visual basic'), 0);
    assert.equal(score('xyz'), 0);
    assert.equal(score('   '), 0);
    assert.ok(score('code vis') > 0);
});

test('matching ignores case and reads C++ and C# as words', () => {
    assert.ok(matchScore('FIRE', 'Firefox') > 0);
    assert.ok(matchScore('c++', 'Notes on C++ templates') > 0);
    assert.equal(matchScore('ab', 'Files', 'tab'), 0);
});

test('sums follow the usual precedence', () => {
    assert.equal(calculate('1 + 2 * 3'), 7);
    assert.equal(calculate('(1 + 2) * 3'), 9);
    assert.equal(calculate('2 ^ 3 ^ 2'), 512);
    assert.equal(calculate('-2 ^ 2'), -4);
    assert.equal(calculate('2 ^ -1'), 0.5);
    assert.equal(calculate('10 % 3'), 1);
    assert.equal(calculate('7 - 2 - 1'), 4);
    assert.equal(calculate('1.5e3 / 3'), 500);
    assert.equal(calculate('.5 + .5'), 1);
});

test('percentages, functions, constants and implied multiplication', () => {
    assert.equal(calculate('20% of 150'), 30);
    assert.equal(calculate('200 * 5%'), 10);
    assert.equal(calculate('sqrt(16) + abs(-2)'), 6);
    assert.equal(calculate('max(1, 7, 3)'), 7);
    assert.equal(calculate('5!'), 120);
    assert.equal(calculate('3 x 4'), 12);
    assert.equal(calculate('6 ÷ 2 × 3'), 9);
    assert.equal(calculate('2 ** 10'), 1024);
    assert.equal(formatNumber(calculate('2pi')), '6.28318530718');
    assert.equal(calculate('3(4 + 1)'), 15);
    assert.equal(calculate('(2 + 3'), 5);
});

test('anything that is not a sum is left to the other results', () => {
    for (const text of ['', '7', 'pi', 'e', '-5', 'firefox', '7zip', '1password', 'sin', 'log', '2 3',
        '1 +', '1 / 0', 'c++', 'a - b', '(5)', '2 +* 3', '1.2.3', '171!', '2.5!'])
        assert.equal(calculate(text), null, text);
});

test('results read without binary noise', () => {
    assert.equal(formatNumber(calculate('0.1 + 0.2')), '0.3');
    assert.equal(formatNumber(calculate('1 / 3')), '0.333333333333');
    assert.equal(formatNumber(calculate('5 - 5')), '0');
    assert.equal(formatNumber(-0), '0');
    assert.equal(formatNumber(calculate('2 ^ 80')), '1.20892581961e+24');
});

test('the web row opens addresses and searches for everything else', () => {
    const engine = 'https://duckduckgo.com/?q=%s';
    assert.deepEqual(webTarget('gnome shell & more', engine), {address: false,
        uri: 'https://duckduckgo.com/?q=gnome%20shell%20%26%20more', label: 'gnome shell & more', engine: 'duckduckgo.com'});
    assert.deepEqual(webTarget('github.com/KanterLabs', engine),
        {address: true, uri: 'https://github.com/KanterLabs', label: 'github.com/KanterLabs'});
    assert.deepEqual(webTarget('https://example.org/a?b=1', engine),
        {address: true, uri: 'https://example.org/a?b=1', label: 'example.org/a?b=1'});
    assert.equal(webTarget('localhost:8080', engine).uri, 'http://localhost:8080');
    assert.equal(webTarget('192.168.1.1', engine).uri, 'http://192.168.1.1');
    assert.equal(webTarget('www.example.museum', engine).uri, 'https://www.example.museum');
    // A file name is not an address.
    assert.equal(webTarget('notes.txt', engine).address, false);
    assert.equal(webTarget('1.5', engine).address, false);
    assert.equal(webTarget('hello', 'https://www.google.com/search?q=%s').engine, 'google.com');
});

test('the web row disappears without a usable search engine', () => {
    assert.equal(webTarget('hello', ''), null);
    assert.equal(webTarget('hello', 'https://example.com/search'), null);
    assert.equal(webTarget('   ', 'https://duckduckgo.com/?q=%s'), null);
    assert.equal(webTarget('example.com', '').uri, 'https://example.com');
});

test('shortcuts compare regardless of spelling', () => {
    assert.ok(sameShortcut('<Super>space', '<super>Space'));
    assert.ok(sameShortcut('<Shift><Super>space', '<Super><Shift>space'));
    assert.ok(sameShortcut('<Primary>space', '<Control>space'));
    assert.ok(sameShortcut('<Ctrl>space', '<Control>space'));
    assert.ok(!sameShortcut('<Super>space', '<Shift><Super>space'));
    assert.ok(!sameShortcut('<Super>space', 'XF86Keyboard'));
    assert.ok(!sameShortcut('<Super>space', '<Super>s'));
});
