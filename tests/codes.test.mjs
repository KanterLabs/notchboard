import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../notchboard@kanterlabs.dev/codes.js', import.meta.url), 'utf8');
const {verificationCode} = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('recognizes numeric verification previews, preserving leading zeroes', () => {
    for (const [title, body, expected] of [
        ['Google', 'G-482913 is your Google verification code.', '482913'],
        ['Your verification code', '482913', '482913'],
        ['Gmail', 'Your security code is 0042. Expires in 10 minutes.', '0042'],
        ['Sign-in code: 482 913', '', '482913'],
        ['One-time password', 'Your password is 482-913.', '482913'],
        ['Login code', 'Use 1234 5678 to continue.', '12345678'],
        ['Your code is 001234', 'Use 001234 to sign in.', '001234'],
        ['Your OpenAI code is 482913', '', '482913'],
        ['Netflix', '482913 is your Netflix code.', '482913'],
        ['Sign-in code', '482\u00a0913', '482913'],
        ['2FA: 987654', '', '987654'],
        ['OTP', '11223344', '11223344'],
    ])
        assert.equal(verificationCode(title, body), expected, `${title}: ${body}`);
});

test('does not guess from ordinary messages, ambiguous numbers or truncated previews', () => {
    for (const [title, body] of [
        ['Order 123456 shipped', 'Arriving tomorrow'],
        ['Discount code 123456', 'Save today'],
        ['Your discount code is 123456', 'Save today'],
        ['Your referral code', '123456'],
        ['Verification code', 'Open this email to view it'],
        ['Your code', '123456 or 654321'],
        ['Your code', 'A123456B'],
        ['Your code', '123456789'],
        ['Your code', '2026-11-01'],
        ['Your code', '2026/11/01'],
        ['Your code', '+1-800-555-1234'],
        ['Your code', '1234.56'],
        ['Your code', 'Expires soon. ' + 'x'.repeat(100) + ' 123456'],
        [null, undefined],
    ])
        assert.equal(verificationCode(title, body), null, `${title}: ${body}`);
});

test('Steam Guard accepts five-character codes including letters without matching prose', () => {
    const title = 'Your Steam account: Access from new web or mobile device';
    assert.equal(verificationCode(title, 'Here is the Steam Guard code you need to access your account: Request made from New York, United States A7B2C If this was not you'), 'A7B2C');
    assert.equal(verificationCode('Steam Support', 'Your Steam Guard code is FJQRP. NEVER SHARE YOUR STEAM GUARD CODE.'), 'FJQRP');
    assert.equal(verificationCode('Steam Support', 'Your Steam Guard code: 01234'), '01234');
    assert.equal(verificationCode('Steam Support', 'Your Steam Guard code: A7B2C or D8E3F'), null);
    assert.equal(verificationCode('Steam Support', 'Here is the Steam Guard code you need to access your account: Request made from'), null);
    assert.equal(verificationCode('Steam Support', 'Your Steam Guard code: NEVER SHARE YOUR STEAM GUARD CODE.'), null);
    assert.equal(verificationCode('Your discount code', 'A7B2C'), null);
});
