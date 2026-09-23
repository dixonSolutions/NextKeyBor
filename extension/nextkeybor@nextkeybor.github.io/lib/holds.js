// Gboard-style long-press variants: digits on the top letter row, common
// symbols on the other letter rows. Works on the layout JSON before the stock
// keyboard turns it into keys; key.strings[0] is what a tap commits, the rest
// are the long-press popup.

const TOP_ROW = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const MIDDLE_ROW = ['@', '#', '$', '_', '&', '-', '+', '(', ')', '/'];
const BOTTOM_ROW = ['*', '"', '\'', ':', ';', '!', '?', '%', '='];

const EXTRA_VARIANTS = {
    ',': [';', ':', '!', '?', '"', '\'', '…'],
    '.': ['…'],
    '-': ['–', '—', '_', '·'],
    '\'': ['‘', '’', '"', '“', '”'],
    '/': ['\\', '|'],
    '?': ['¿', '‽'],
    '!': ['¡'],
};

const LETTER = /^\p{L}$/u;

function isLetterKey(key) {
    return !key.action && !key.keyval && key.strings?.length > 0 &&
        LETTER.test(key.strings[0]);
}

function addVariant(key, variant) {
    if (key.strings.includes(variant))
        return;
    key.strings.splice(1, 0, variant);
}

// `rowIndex` is 1-based, as KeyContainer counts rows. `levelMode` is the
// level's "mode": letters live on the "default" and "latched" (shift) levels.
export function augmentRow(keys, rowIndex, levelMode) {
    if (levelMode !== 'default' && levelMode !== 'latched')
        return;

    const table = [TOP_ROW, MIDDLE_ROW, BOTTOM_ROW][rowIndex - 1];
    let column = 0;
    for (const key of keys) {
        if (isLetterKey(key)) {
            if (table && column < table.length)
                addVariant(key, table[column]);
            column++;
            continue;
        }
        const extra = key.strings?.length ? EXTRA_VARIANTS[key.strings[0]] : null;
        if (extra) {
            for (const v of [...extra].reverse())
                addVariant(key, v);
        }
    }
}
