import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router/', import.meta.url));
const { pipeAnthropicBody } = await import(pathToFileURL(path.join(root, 'relay.mjs')).href);
const events = [
    { type: 'message_start', message: { id: 'msg_terminal', model: 'upstream', content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
    { type: 'error', error: { type: 'api_error', message: 'late frame must not contaminate a completed turn' } },
];
let source;
let canceled = false;
const upstream = new Response(new ReadableStream({
    start(controller) { source = controller; controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))); },
    cancel() { canceled = true; },
}));
const res = new EventEmitter();
res.frames = [];
res.write = frame => { res.frames.push(frame); return true; };
res.end = () => { res.writableEnded = true; res.emit('finish'); };
const usage = [];
const pending = pipeAnthropicBody(upstream, res, 'client-alias', true, value => usage.push(value), null, { stopOnMessageStop: true });
try
{
    // Let the already-enqueued frame's microtasks run. The source deliberately
    // never sends EOF, so completion depends only on the observed message_stop.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(res.frames.some(frame => frame.includes('event: message_stop')), 'fixture never reached its terminal event');
    assert.equal(res.writableEnded, true, 'Fireworks relay must finish at message_stop without waiting for HTTP EOF');
    assert.equal(canceled, true, 'completed message must release its upstream HTTP/2 stream');
    assert.equal(res.frames.length, 6);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].usage.output_tokens, 1);
    assert.equal(res.listenerCount('close'), 0);
    console.log('PASS Fireworks terminal release: no EOF dependency, no trailing frames, exact usage, no close-listener leak');
}
finally { if (!canceled) source.close(); await pending; }
