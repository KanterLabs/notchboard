// Notification previews only: no inbox access, storage, or network requests.
// Prefer missing an uncertain code to copying a date, phone number or order ID.
export function verificationCode(title, body) {
    const text = `${title ?? ''}\n${body ?? ''}`.replace(/\s+/g, ' ');
    const cues = [...text.matchAll(/\b(?:(?:verification|security|authentication|authorization|confirmation|sign[ -]?in|log[ -]?in|one[ -]?time|access)\s+(?:pass(?:word|code)|code)|(?:otp|2fa)|your\s+(?:(?!(?:discount|promo|coupon|referral|gift|tracking|order|postal|zip)\b)\w+[ -]){0,3}(?:code|passcode))\b/gi)];
    const steamCues = [...text.matchAll(/\bSteam Guard code\b/gi)];
    if (!cues.length && !steamCues.length)
        return null;
    const codes = new Set();
    // Steam includes a location between its code introduction and the token.
    // Only accept five-character tokens in that explicit Steam Guard context;
    // uppercase prose and ambiguous previews must never become copied codes.
    const prose = new Set(['STEAM', 'GUARD', 'EMAIL', 'LOGIN', 'SHARE', 'NEVER',
        'ENTER', 'CLICK', 'AGAIN', 'ABOUT', 'THESE', 'BELOW', 'ABOVE', 'VALID']);
    for (const match of text.matchAll(/\b[A-Z0-9]{5}\b/g)) {
        if (!prose.has(match[0]) && steamCues.some(cue => {
            const after = match.index - (cue.index + cue[0].length);
            return after >= 0 && after <= 160;
        }))
            codes.add(match[0]);
    }
    for (const match of text.matchAll(/(?<![\w.+/-])(?:\d{3}[ -]\d{3}|\d{4} \d{4}|\d{4,8})(?![\w]|[.,/-]\d)/g)) {
        // G-123456 is Google's numeric code, handled separately below.
        if (cues.some(cue => Math.max(cue.index - (match.index + match[0].length),
            match.index - (cue.index + cue[0].length)) <= 80))
            codes.add(match[0].replace(/[ -]/g, ''));
    }
    for (const match of text.matchAll(/\bG-(\d{6})(?!\w)/g)) {
        if (cues.some(cue => Math.abs(cue.index - match.index) <= 80))
            codes.add(match[1]);
    }
    return codes.size === 1 ? [...codes][0] : null;
}
