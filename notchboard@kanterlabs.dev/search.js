// Kept independent of Shell so matching and sums can be tested directly.

const wordsOf = text => text.toLocaleLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);

// How well `query` matches a result called `name`; `extra` is further
// searchable text such as keywords. Every query word has to match somewhere.
// 0 means no match, and a higher score is a better one.
export function matchScore(query, name, extra = '') {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length)
        return 0;
    const lowerName = name.toLocaleLowerCase();
    const lowerExtra = extra.toLocaleLowerCase();
    const whole = terms.join(' ');
    if (lowerName === whole)
        return 100;
    if (lowerName.startsWith(whole))
        return 95;
    const nameWords = wordsOf(name);
    const extraWords = wordsOf(extra);
    const initials = nameWords.map(word => word[0]).join('');
    let total = 0;
    for (const term of terms) {
        let score = 0;
        if (lowerName.startsWith(term))
            score = 90;
        else if (nameWords.some(word => word.startsWith(term)))
            score = 70;
        // "vsc" finds Visual Studio Code.
        else if (terms.length === 1 && term.length > 1 && initials.startsWith(term))
            score = 60;
        else if (lowerName.includes(term))
            score = 40;
        else if (extraWords.some(word => word.startsWith(term)))
            score = 25;
        else if (term.length > 2 && lowerExtra.includes(term))
            score = 10;
        if (!score)
            return 0;
        total += score;
    }
    return total / terms.length;
}

const FUNCTIONS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    ln: Math.log, log: Math.log10, log2: Math.log2,
    round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max,
};
const CONSTANTS = {pi: Math.PI, 'π': Math.PI, tau: 2 * Math.PI, e: Math.E};
// Words and symbols that stand for an operator.
const ALIASES = {'**': '^', '×': '*', '·': '*', '÷': '/', '−': '-', x: '*', of: '*', mod: '%'};
const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)|([a-zπ][a-z0-9]*)|(\*\*|[-+*/^%()!,×÷−·]))/y;

function tokenize(text) {
    const source = text.toLowerCase().trim();
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < source.length) {
        const match = TOKEN.exec(source);
        if (!match)
            return null;
        const [, number, word, symbol] = match;
        if (number !== undefined)
            tokens.push({number: Number(number)});
        else if ((word ?? symbol) in ALIASES)
            tokens.push({op: ALIASES[word ?? symbol]});
        else if (word !== undefined)
            tokens.push({word});
        else
            tokens.push({op: symbol});
    }
    return tokens;
}

function factorial(value) {
    if (!Number.isInteger(value) || value < 0 || value > 170)
        throw new Error('factorial');
    let result = 1;
    for (let i = 2; i <= value; i++)
        result *= i;
    return result;
}

// The value of a sum such as "12 * (3 + 4)", "20% of 150" or "sqrt(2)", or
// null for anything that is not one. A lone number is not a sum: typing "7"
// should find things called 7, not report that 7 is 7.
export function calculate(text) {
    const tokens = tokenize(text);
    if (!tokens?.length)
        return null;
    let position = 0;
    let operations = 0;
    const op = symbol => tokens[position]?.op === symbol && !!++position;
    const operand = token => !!token && (token.number !== undefined || !!token.word || token.op === '(');

    const primary = () => {
        const token = tokens[position++];
        if (token?.number !== undefined)
            return token.number;
        if (token?.op === '(') {
            const value = expression();
            // A bracket still open at the end is closed for you while typing.
            if (!op(')') && position < tokens.length)
                throw new Error('bracket');
            return value;
        }
        if (token?.word && Object.hasOwn(FUNCTIONS, token.word)) {
            if (!op('('))
                throw new Error('arguments');
            const values = [expression()];
            while (op(','))
                values.push(expression());
            if (!op(')') && position < tokens.length)
                throw new Error('bracket');
            operations++;
            return FUNCTIONS[token.word](...values);
        }
        if (token?.word && Object.hasOwn(CONSTANTS, token.word))
            return CONSTANTS[token.word];
        throw new Error('operand');
    };
    const postfix = () => {
        let value = primary();
        for (;;) {
            if (op('!')) {
                value = factorial(value);
            // "10 % 3" is a remainder; "10%" is a tenth.
            } else if (tokens[position]?.op === '%' && !operand(tokens[position + 1])) {
                position++;
                value /= 100;
            } else {
                return value;
            }
            operations++;
        }
    };
    const power = () => {
        const base = postfix();
        if (!op('^'))
            return base;
        operations++;
        return base ** unary();
    };
    const unary = () => op('-') ? -unary() : op('+') ? unary() : power();
    const term = () => {
        let value = unary();
        for (;;) {
            if (op('*'))
                value *= unary();
            else if (op('/'))
                value /= unary();
            else if (op('%'))
                value %= unary();
            // "2pi" and "3(4 + 1)" multiply; "2 3" is not a sum.
            else if (tokens[position]?.word || tokens[position]?.op === '(')
                value *= power();
            else
                return value;
            operations++;
        }
    };
    const expression = () => {
        let value = term();
        for (;;) {
            if (op('+'))
                value += term();
            else if (op('-'))
                value -= term();
            else
                return value;
            operations++;
        }
    };

    try {
        const value = expression();
        return position === tokens.length && operations > 0 && Number.isFinite(value) ? value : null;
    } catch (_) {
        return null;
    }
}

// Twelve significant digits hide binary noise: 0.1 + 0.2 reads 0.3.
export function formatNumber(value) {
    const rounded = Number(value.toPrecision(12));
    return rounded === 0 ? '0' : String(rounded);
}

const TLDS = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov', 'me', 'tv',
    'xyz', 'info', 'uk', 'de', 'fr', 'nl', 'eu', 'ca', 'us', 'au', 'jp', 'in', 'ch', 'se', 'es', 'it', 'br']);
const ADDRESS = /^(?:(localhost|\d{1,3}(?:\.\d{1,3}){3})|((?:[a-z0-9-]+\.)+([a-z]{2,})))(?::\d+)?(?:[/?#]\S*)?$/i;

// Where the web row leads: straight to an address when the query is one,
// otherwise to the search engine in `template`, whose %s is the query.
export function webTarget(query, template) {
    const text = query.trim();
    if (!text)
        return null;
    if (/^https?:\/\/\S+$/i.test(text))
        return {address: true, uri: text, label: text.replace(/^https?:\/\//i, '')};
    const [, local, domain, tld] = ADDRESS.exec(text) ?? [];
    if (local)
        return {address: true, uri: `http://${text}`, label: text};
    if (domain && (TLDS.has(tld.toLowerCase()) || /^www\./i.test(domain)))
        return {address: true, uri: `https://${text}`, label: text};
    const engine = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(template)?.[1];
    if (!engine || !template.includes('%s'))
        return null;
    return {address: false, uri: template.replace('%s', encodeURIComponent(text)), label: text, engine};
}
