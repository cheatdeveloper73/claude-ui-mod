'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const A = 'local_11111111-2222-3333-4444-555555555555';
const B = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const modulePath = require.resolve('../src/plugins/queue/main.js');

function settle() {
    return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

function start(queue, settings, busy) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-queue-main-'));
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.state', 'queue.json'), JSON.stringify(queue));
    fs.writeFileSync(path.join(root, '.state', 'settings.json'), JSON.stringify({ queue: settings }));

    const sent = [];
    const sessions = new Map(Object.keys(queue).map(sid => [sid, { query: {}, busy: !!busy[sid] }]));
    const manager = {
        sessions,
        isCliProvablyIdle(session) { return !session.busy; },
        async sendMessage(sid, text, images, options) {
            sent.push({ sid, text, images, options });
            sessions.get(sid).busy = true;
            return { delivered: true };
        },
    };
    const fixtureKey = path.join(root, 'manager-fixture.cjs');
    require.cache[fixtureKey] = { exports: { claudeCodeSessionManager: manager } };
    delete require.cache[modulePath];

    const methods = new Map();
    const intervals = [];
    const disposers = [];
    const broadcasts = [];
    require(modulePath)({
        boot: { MOD_DIR: root },
        dir: path.join(root, 'src', 'plugins', 'queue'),
        method(name, fn) { methods.set(name, fn); },
        every(_ms, fn) { intervals.push(fn); },
        onDispose(fn) { disposers.push(fn); },
        broadcast(value) { broadcasts.push(value); },
        log() {},
    });

    return {
        root, sent, sessions, methods, broadcasts,
        scan() { intervals[0](); },
        close() {
            for (let index = disposers.length - 1; index >= 0; index--) disposers[index]();
            delete require.cache[fixtureKey];
            delete require.cache[modulePath];
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

const IMAGE = { base64: 'iVBORw0KGgo=', mimeType: 'image/png', filename: 'shot.png' };
const item = (id, text, images) => ({ id, text, ...(images ? { images } : {}), at: 1 });

function editorPage(images = [IMAGE]) {
    let text = 'look at this';
    let doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
    let staged = images.map((image, index) => ({
        status: 'ready', id: 'image-' + index, name: image.filename, source: 'userFile',
        block: { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
    }));
    const added = [];
    let takes = 0;
    const attachments = {
        getImages() { return staged; },
        hasStagedAttachmentsNow() { return staged.length > 0; },
        waitForImagesReady() { return Promise.resolve(); },
        addImageFiles(files) { added.push(...files); return files.length; },
        takeForSend() { takes++; const value = staged; staged = []; return { images: value.map(image => image.block), files: [], snippets: [] }; },
    };
    const root = {
        querySelector() { return null; },
        getBoundingClientRect() { return { width: 768, bottom: 900 }; },
    };
    root.__reactFiber$test = { memoizedProps: null, memoizedState: null,
        return: { memoizedProps: { staging: attachments }, memoizedState: null, return: null } };
    const editor = {
        isFocused: true,
        getText() { return text; },
        getJSON() { return doc; },
        commands: {
            clearContent() { text = ''; doc = { type: 'doc', content: [{ type: 'paragraph' }] }; },
            setContent(value) { doc = value; text = value.content.map(paragraph => paragraph.content?.[0]?.text || '').join('\n'); },
            focus() {},
        },
    };
    const node = {
        editor,
        closest(selector) { return selector === '.epitaxy-prompt' ? root : null; },
        getBoundingClientRect() { return { width: 768, bottom: 900 }; },
    };
    class FakeFile {
        constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; }
    }
    const context = {
        document: { querySelectorAll() { return [node]; } },
        File: FakeFile,
        Uint8Array,
        atob,
        setTimeout,
        Promise,
    };
    const sender = { executeJavaScript(script) { return vm.runInNewContext(script, context); } };
    return { sender, attachments, added, editor, get takes() { return takes; } };
}

test('main-process drain releases every idle session without a focused renderer', async () => {
    const f = start({
        [A]: [item('a1', 'first A'), item('a2', 'second A')],
        [B]: [item('b1', 'first B')],
    }, { enabled: true, autoSend: true, autoSendDelay: 0 }, { [A]: true, [B]: false });
    try {
        await settle();
        assert.deepEqual(f.sent.map(call => [call.sid, call.text]), [[B, 'first B']]);
        assert.deepEqual(f.sent[0].options, { initiator: 'user' });
        assert.deepEqual(f.methods.get('load')()[A].map(row => row.id), ['a1', 'a2']);
        assert.equal(f.methods.get('load')()[B], undefined);

        f.sessions.get(A).busy = false;
        f.scan();
        await settle();
        assert.deepEqual(f.sent.map(call => [call.sid, call.text]), [[B, 'first B'], [A, 'first A']]);
        assert.deepEqual(f.methods.get('load')()[A].map(row => row.id), ['a2']);

        // The first release starts a turn. The next item stays queued until that
        // same background session becomes provably idle again.
        f.scan();
        await settle();
        assert.equal(f.sent.length, 2);
        f.sessions.get(A).busy = false;
        f.scan();
        await settle();
        assert.deepEqual(f.sent.map(call => call.text), ['first B', 'first A', 'second A']);

        const disk = JSON.parse(fs.readFileSync(path.join(f.root, '.state', 'queue.json'), 'utf8'));
        assert.deepEqual(disk, {});
        assert.ok(f.broadcasts.some(event => event.type === 'queue-changed' && event.sessionId === B && event.sentId === 'b1'));
    } finally { f.close(); }
});

// App 2.9939.4 moved isCliProvablyIdle off the manager into a module-local
// function; hasAgentRunInProgress(sessionId) is the surviving public wrapper.
test('auto-send drains on a manager without isCliProvablyIdle', async () => {
    const f = start({ [A]: [item('a1', 'after turn')] },
        { enabled: true, autoSend: true, autoSendDelay: 0 }, { [A]: true });
    try {
        const mgr = require.cache[path.join(f.root, 'manager-fixture.cjs')].exports.claudeCodeSessionManager;
        delete mgr.isCliProvablyIdle;
        mgr.hasAgentRunInProgress = (sid) => f.sessions.get(sid).busy;
        await settle();
        assert.equal(f.sent.length, 0);

        f.sessions.get(A).busy = false;
        f.sessions.get(A).cliLastTurnMessageWasResult = false;
        f.scan();
        await settle();
        assert.equal(f.sent.length, 0, 'a turn that has not reached its result is not idle');

        f.sessions.get(A).cliLastTurnMessageWasResult = true;
        f.scan();
        await settle();
        assert.deepEqual(f.sent.map(call => call.text), ['after turn']);
        assert.equal(f.methods.get('status')().manager.idlePredicate, true);
    } finally { f.close(); }
});

test('auto-send configuration and edit holds are enforced in main', async () => {
    const f = start({ [A]: [item('a1', 'held')] },
        { enabled: true, autoSend: false, autoSendDelay: 0 }, { [A]: false });
    try {
        await settle();
        assert.equal(f.sent.length, 0);
        assert.equal(f.methods.get('hold')({ sid: A, id: 'a1' }), true);
        f.methods.get('configure')({ enabled: true, autoSend: true, autoSendDelay: 0 });
        await settle();
        assert.equal(f.sent.length, 0);

        f.methods.get('hold')({ sid: A, id: null });
        f.scan();
        await settle();
        assert.deepEqual(f.sent.map(call => call.text), ['held']);
    } finally { f.close(); }
});

test('image-only items persist and auto-send through the native image argument', async () => {
    const f = start({ [A]: [item('a1', '', [IMAGE])] },
        { enabled: true, autoSend: true, autoSendDelay: 0 }, { [A]: false });
    try {
        await settle();
        assert.equal(f.sent.length, 1);
        assert.equal(f.sent[0].text, '');
        assert.deepEqual(f.sent[0].images, [IMAGE]);
        assert.deepEqual(f.sent[0].options, { initiator: 'user' });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '.state', 'queue.json'), 'utf8')), {});
    } finally { f.close(); }
});

test('page-world editor methods snapshot, clear, and restore native staged images', async () => {
    const f = start({}, { enabled: true, autoSend: false, autoSendDelay: 0 }, {});
    const page = editorPage();
    try {
        const snapshot = await f.methods.get('editorGet')({}, { sender: page.sender });
        assert.equal(snapshot.ok, true);
        assert.equal(snapshot.text, 'look at this');
        assert.equal(snapshot.empty, false);
        assert.deepEqual(JSON.parse(JSON.stringify(snapshot.images)), [IMAGE]);

        assert.equal((await f.methods.get('editorClear')({}, { sender: page.sender })).ok, true);
        assert.equal(page.takes, 1);
        assert.equal(page.editor.getText(), '');

        const restored = await f.methods.get('editorSet')({ text: 'edited', images: [IMAGE] }, { sender: page.sender });
        assert.equal(restored.ok, true);
        assert.equal(restored.images, 1);
        assert.equal(page.editor.getText(), 'edited');
        assert.equal(page.added.length, 1);
        assert.equal(page.added[0].name, 'shot.png');
        assert.equal(page.added[0].type, 'image/png');
    } finally { f.close(); }
});

test('steer and item mutations share the authoritative queue', async () => {
    const f = start({ [A]: [item('a1', 'old', [IMAGE]), item('a2', 'keep')] },
        { enabled: true, autoSend: false, autoSendDelay: 0 }, { [A]: true });
    try {
        const updated = f.methods.get('update')({ sid: A, id: 'a1', text: 'new' });
        assert.deepEqual(updated.map(row => row.text), ['new', 'keep']);
        assert.deepEqual(updated[0].images, [IMAGE], 'a text-only hot-generation update retains images');
        const steered = await f.methods.get('steer')({ sid: A, id: 'a1', freeForeground: false });
        assert.equal(steered.ok, true);
        assert.equal(steered.priority, 'next');
        assert.deepEqual(f.sent[0], { sid: A, text: 'new', images: [IMAGE],
            options: { initiator: 'user', priority: 'next' } });
        assert.deepEqual(steered.items.map(row => row.id), ['a2']);

        const appended = f.methods.get('enqueue')({ sid: A, item: item('a3', 'last') });
        assert.deepEqual(appended.map(row => row.id), ['a2', 'a3']);
        const removed = f.methods.get('remove')({ sid: A, id: 'a2' });
        assert.deepEqual(removed.map(row => row.id), ['a3']);
    } finally { f.close(); }
});

// A steer's echo reaches the renderer the moment main accepts it, even when the
// desktop then holds the input until the text stream ends. The web store only
// routes that echo into its steered bar when noteQueuedSend ran first, as the
// native composer does; without it the message renders above the live stream.
function storePage(order) {
    const calls = [];
    function noteQueuedSend(sid) { calls.push(sid); order.push('note'); }
    const hookChain = { memoizedState: {}, next: { memoizedState: noteQueuedSend, next: null } };
    const leaf = { memoizedState: hookChain, child: null, sibling: null };
    const hostRoot = { memoizedState: null, child: { memoizedState: null, child: leaf, sibling: null }, sibling: null };
    hostRoot.stateNode = { current: hostRoot };
    const container = { '__reactContainer$test': hostRoot };
    const context = vm.createContext({ document: { querySelectorAll: () => [container] } });
    const sender = { executeJavaScript(script) { return Promise.resolve(vm.runInNewContext(script, context)); } };
    return { sender, calls };
}

test('steer registers the send with the web store before main emits its echo', async () => {
    const f = start({ [A]: [item('a1', 'steer me')] },
        { enabled: true, autoSend: false, autoSendDelay: 0 }, { [A]: true });
    try {
        const order = [];
        const page = storePage(order);
        const mgr = require.cache[path.join(f.root, 'manager-fixture.cjs')].exports.claudeCodeSessionManager;
        const original = mgr.sendMessage;
        mgr.sendMessage = async (...args) => { order.push('send'); return original(...args); };
        const steered = await f.methods.get('steer')({ sid: A, id: 'a1', freeForeground: false }, { sender: page.sender });
        assert.equal(steered.ok, true);
        assert.deepEqual(page.calls, [A]);
        assert.deepEqual(order, ['note', 'send']);
    } finally { f.close(); }
});
