// The tok/s chip's DOM surgery, run against both vocabularies the app's marker
// strip was measured to use on 2026-09-01.
//
// Two bugs are pinned here, both found by measuring the running page rather than
// by reasoning about it:
//
//   1. Mid-turn, each chip carries its own leading separator as a real element
//      holding a private-use glyph. Writing the label by walking to "the
//      innermost element with text" finds that separator, and would have
//      rendered "~112 tok/s4 tokens".
//   2. Once the turn settles the chips become cds buttons with `px-md
//      mx-outset` — 6px padding cancelled by -6px margin — and no separator at
//      all. Cloning one put two buttons 12px ON TOP of each other with nothing
//      between them: "1 running task94.5 tok/s".
//
// The functions are sliced out of the shipped renderer rather than copied, so
// this cannot pass against a stale duplicate. If the slice markers move the test
// fails loudly instead of testing nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SEP = String.fromCharCode(0xe062);
const CHIP_MARK = 'data-cuimod-tps';

// ------------------------------------------------------------ a minimal DOM
class Element {
    constructor(tag, classes) {
        this.nodeType = 1;
        this.tagName = String(tag || 'SPAN').toUpperCase();
        this.childNodes = [];
        this.attrs = new Map();
        this.classes = new Set(String(classes || '').split(' ').filter(Boolean));
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(' ').filter(Boolean)); }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get classList() { return { contains: name => this.classes.has(name) }; }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this.childNodes = [new Text(value, this)]; }
    appendChild(node) { node.remove(); node.parent = this; this.childNodes.push(node); return node; }
    // Inserting a node that already has a parent MOVES it. Getting this wrong
    // made the reposition test report the chip twice, which is a bug in the
    // harness and not in the code it is checking.
    insertBefore(node, ref) {
        node.remove();
        node.parent = this;
        const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
        this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
        return node;
    }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() {
        const kids = this.parent ? this.parent.childNodes : [];
        return kids[kids.indexOf(this) + 1] || null;
    }
    get previousElementSibling() {
        const kids = this.parent ? this.parent.children : [];
        return kids[kids.indexOf(this) - 1] || null;
    }
    get parentElement() { return this.parent || null; }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    cloneNode() {
        const copy = new Element(this.tagName, this.className);
        for (const [k, v] of this.attrs) copy.attrs.set(k, v);
        for (const kid of this.childNodes) copy.appendChild(kid.nodeType === 1 ? kid.cloneNode(true) : new Text(kid.value));
        return copy;
    }
    querySelector(selector) {
        const wanted = selector.replace(/^\./, '');
        const walk = (node) => {
            for (const kid of node.children) {
                if (kid.classes.has(wanted)) return kid;
                const deeper = walk(kid);
                if (deeper) return deeper;
            }
            return null;
        };
        return walk(this);
    }
    remove() {
        const at = this.parent ? this.parent.childNodes.indexOf(this) : -1;
        if (at >= 0) this.parent.childNodes.splice(at, 1);
    }
}

class Text {
    constructor(value, parent) { this.nodeType = 3; this.value = value; this.parent = parent || null; }
    get textContent() { return this.value; }
    set textContent(value) { this.value = value; }
    get childNodes() { return []; }
    get children() { return []; }
    remove() {
        const at = this.parent ? this.parent.childNodes.indexOf(this) : -1;
        if (at >= 0) this.parent.childNodes.splice(at, 1);
    }
}

function span(classes, ...kids) {
    const node = new Element('span', classes);
    for (const kid of kids) node.appendChild(typeof kid === 'string' ? new Text(kid) : kid);
    return node;
}

// --------------------------------------------------- the code under test
const source = fs.readFileSync(fileURLToPath(new URL('../src/plugins/throughput/renderer.js', import.meta.url)), 'utf8');
const from = source.indexOf('const privateUse =');
const to = source.indexOf('function removeChip()');
assert.ok(from !== -1 && to > from, 'the chip helpers moved; update this slice before trusting the result');

const sandbox = {
    document: {
        createTextNode: value => new Text(value),
        createElement: tag => new Element(tag, ''),
    },
    CHIP_MARK,
};
vm.createContext(sandbox);
// A `const` in a vm script does not attach to the context object, so the slice
// hands its bindings out explicitly from inside its own scope.
vm.runInContext(source.slice(from, to)
    + ';globalThis.sliced = { privateUse, isSeparator, retext, anchorOf, separatorFor, buildChip, placeChip, syncSeparator };', sandbox);
const { isSeparator, retext, anchorOf, separatorFor, buildChip, placeChip, syncSeparator } = sandbox.sliced;
assert.ok(retext && anchorOf && buildChip && separatorFor && placeChip, 'a chip helper was not defined by the slice');

// -------------------------------------------------------------- fixtures
// Mid-turn, verbatim from a .probe capture (session a3f2a094, visible window):
//   7m 6s | 3.6k tokens | 1 running task | Running tools…
// where every chip after the first opens with <span class="px-xs">U+E062</span>.
function midTurnStrip() {
    const wrap = span('inline-flex items-center min-w-0 max-w-full');
    wrap.appendChild(span('inline-flex items-center', '7m 6s'));
    wrap.appendChild(span('inline-flex items-center', span('px-xs', SEP), '3.6k tokens'));
    wrap.appendChild(span('inline-flex items-center', span('px-xs', SEP),
        span('cds-reset group/btn', '1 running task')));
    wrap.appendChild(span('inline-flex items-center', span('px-xs', SEP),
        span('epitaxy-thinking-shimmer', span('inline-flex', 'Running tools'))));
    return wrap;
}

// Settled, verbatim from the same audit (session 5130deb3): one cds button,
// px-md mx-outset, no separator anywhere in the strip.
function settledStrip() {
    const wrap = span('inline-flex items-center min-w-0 max-w-full');
    const button = new Element('button', 'cds-reset group/btn relative isolate inline-flex px-md mx-outset');
    button.setAttribute('data-cds', 'Button');
    button.setAttribute('data-size', 'xs');
    button.appendChild(span('absolute cds-btn-squish'));
    button.appendChild(span('absolute inset-0'));
    button.appendChild(span('inline-flex min-w-0 items-center gap-1', span('text-footnote', '1 running task')));
    wrap.appendChild(button);
    return wrap;
}

const readable = value => value.split(SEP).join('|');

// paintChip's DOM half, using the shipped helpers rather than a copy of them.
function place(wrap, label, existing) {
    const anchor = anchorOf(wrap);
    if (!anchor) return null;
    const chip = existing || buildChip(wrap);
    placeChip(wrap, chip, anchor);
    retext(chip, label);
    return chip;
}

test('mid-turn the chip lands after the token count and keeps the strip’s rhythm', () => {
    const wrap = midTurnStrip();
    const chip = place(wrap, '~112 tok/s');
    assert.equal(readable(wrap.textContent), '7m 6s|3.6k tokens|~112 tok/s|1 running task|Running tools');
    assert.equal(chip.tagName, 'SPAN');
    assert.equal(chip.className, 'inline-flex items-center', 'the same shell the app uses for a text chip');
});

test('the settled strip borrows a separator it cannot lend', () => {
    // The bug: cloning the only chip produced a second cds button with px-md and
    // mx-outset, measured overlapping the first by 12px, and no separator at all.
    // The settled strip has none of its own, so the cached one carries it.
    separatorFor(midTurnStrip());
    const wrap = settledStrip();
    const chip = place(wrap, '94.5 tok/s');
    assert.equal(readable(wrap.textContent), '1 running task|94.5 tok/s');
    assert.equal(chip.tagName, 'SPAN', 'never a button: it is a readout, not a control');
    assert.equal(chip.hasAttribute('data-cds'), false, 'no cds paint layers, no outset margins');
    assert.equal(chip.children[0].className, 'px-xs');
    assert.equal(chip.children[0].textContent, SEP);
});

test('the separator is always one of the app’s, never a rebuilt one', () => {
    // A hand-built span.px-xs carrying the same code point measured 20px against
    // the app's 12.4px, so a bundle change to glyph, class or width is inherited
    // by cloning rather than approximated.
    const wrap = midTurnStrip();
    const moved = String.fromCharCode(0xe999);
    for (const chip of wrap.children) {
        const sep = chip.children[0];
        if (sep && sep.classes.has('px-xs')) sep.textContent = moved;
    }
    assert.equal(separatorFor(wrap).textContent, moved);
});

test('a separator cached from an earlier strip is replaced by a live one', () => {
    // A chip built while the strip was a lone status word keeps the cached
    // separator; once the app renders its own again, that one wins.
    separatorFor(midTurnStrip());
    const lone = span('inline-flex items-center min-w-0 max-w-full');
    lone.appendChild(span('inline-flex items-center', 'Sending'));
    const chip = place(lone, '37.8 tok/s');
    assert.equal(readable(lone.textContent), 'Sending|37.8 tok/s');

    const grown = midTurnStrip();
    for (const c of grown.children) {
        const sep = c.children[0];
        if (sep && sep.classes.has('px-xs')) sep.className = 'px-sm';
    }
    grown.insertBefore(chip, grown.children[2]);
    syncSeparator(grown, chip);
    assert.equal(chip.children[0].className, 'px-sm', 'the app is the authority on its own separator');
    assert.equal(chip.children.length, 1, 'exactly one separator, not two');
    assert.equal(readable(chip.textContent).replace(/^\|/, ''), '37.8 tok/s');
});

test('a window that has never seen a separator builds no chip', () => {
    const before = separatorFor(span('inline-flex items-center'));
    if (before) return;                       // cache already primed by an earlier test
    const lone = span('inline-flex items-center');
    lone.appendChild(span('inline-flex items-center', 'Sending'));
    assert.equal(buildChip(lone), null, 'better no chip than one sitting flush against its neighbour');
});

test('an unchanged label does not touch the DOM', () => {
    const wrap = midTurnStrip();
    const chip = place(wrap, '~112 tok/s');
    const before = chip.childNodes.slice();
    retext(chip, '~112 tok/s');
    // Our own mutation feeds the observer that schedules the next paint, so a
    // rewrite per tick would keep that loop turning for nothing.
    assert.deepEqual(chip.childNodes, before);
    retext(chip, '~118 tok/s');
    assert.equal(readable(chip.textContent), '|~118 tok/s');
});

test('the separator survives every relabel', () => {
    const wrap = midTurnStrip();
    const chip = place(wrap, '~112 tok/s');
    for (const label of ['~64.8 tok/s', '119 tok/s', '~1,204 tok/s ×3', '90.0 tok/s']) {
        retext(chip, label);
        assert.equal(readable(chip.textContent), '|' + label);
        assert.equal(chip.children.length, 1, 'exactly one child element, the separator');
    }
});

test('the separator is recognised by its code point, not only its class', () => {
    const chip = span('inline-flex items-center', span('renamed-by-a-bundle-update', SEP), '3.6k tokens');
    assert.equal(isSeparator(chip.children[0]), true);
    retext(chip, '90 tok/s');
    assert.equal(readable(chip.textContent), '|90 tok/s');
});

test('our own chip is never chosen as the anchor', () => {
    const wrap = midTurnStrip();
    place(wrap, '~112 tok/s');
    const anchor = anchorOf(wrap);
    assert.equal(anchor.hasAttribute(CHIP_MARK), false);
    assert.equal(readable(anchor.textContent), '|3.6k tokens', 'still the token chip, not ours');
});

test('a single-chip strip with no token count takes the chip at the end', () => {
    const wrap = span('inline-flex items-center');
    wrap.appendChild(span('inline-flex items-center', 'Waiting for Claude'));
    const chip = place(wrap, '119 tok/s');
    assert.equal(readable(wrap.textContent), 'Waiting for Claude|119 tok/s');
    assert.equal(chip.children[0].className, 'px-xs');
});

test('an empty strip is left alone', () => {
    const wrap = span('inline-flex items-center');
    assert.equal(anchorOf(wrap), null);
    assert.equal(place(wrap, '119 tok/s'), null);
});

test('the chip follows the anchor as the strip fills in', () => {
    // Measured regression: the strip opens as a lone status chip, so the chip was
    // placed at the end, and the elapsed clock and token count then appeared
    // AHEAD of it -- leaving `2s | 1.1k tokens | Thinking… | 82.0 tok/s`.
    const wrap = span('inline-flex items-center min-w-0 max-w-full');
    wrap.appendChild(span('inline-flex items-center', 'Thinking'));
    const chip = place(wrap, '82.0 tok/s');
    assert.equal(readable(wrap.textContent), 'Thinking|82.0 tok/s');

    // The app re-renders the strip when it grows, and the chip that was first
    // gains the separator it did not carry while it was alone. Confirmed in the
    // live capture: `2s | 1.1k tokens | Thinking… | 82.0 tok/s` has a separator
    // ahead of Thinking as well as ahead of ours.
    const status = wrap.children[0];
    status.insertBefore(span('px-xs', SEP), status.childNodes[0]);
    wrap.insertBefore(span('inline-flex items-center', '2s'), wrap.childNodes[0]);
    wrap.insertBefore(span('inline-flex items-center', span('px-xs', SEP), '1.1k tokens'), wrap.childNodes[1]);
    assert.equal(placeChip(wrap, chip, anchorOf(wrap)), 'moved');
    assert.equal(readable(wrap.textContent), '2s|1.1k tokens|82.0 tok/s|Thinking');
});

test('a chip already in the right place is not re-inserted', () => {
    const wrap = midTurnStrip();
    const chip = place(wrap, '~112 tok/s');
    // insertBefore is a mutation even when it moves nothing, and our own
    // mutations are what schedule the next paint.
    assert.equal(placeChip(wrap, chip, anchorOf(wrap)), 'kept');
    assert.equal(readable(wrap.textContent), '7m 6s|3.6k tokens|~112 tok/s|1 running task|Running tools');
});
