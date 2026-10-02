#!/usr/bin/env node
const seconds = Math.max(5, Math.min(60, Number(process.argv[2]) || 20));
const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const target = targets.find(value => value.webSocketDebuggerUrl);
if (!target) throw new Error('router inspector target not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (!value.id || !pending.has(value.id)) return;
    const { resolve, reject } = pending.get(value.id);
    pending.delete(value.id);
    if (value.error) reject(new Error(value.error.message));
    else resolve(value.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
});

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 500 });
await send('Profiler.start');
await new Promise(resolve => setTimeout(resolve, seconds * 1000));
const { profile } = await send('Profiler.stop');
socket.close();

const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
const micros = new Map();
for (let i = 0; i < profile.samples.length; i++)
    micros.set(profile.samples[i], (micros.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
const rows = [...micros].map(([id, us]) => ({
    ms: Number((us / 1000).toFixed(1)),
    function: nodes.get(id)?.functionName || '(anonymous)',
    file: nodes.get(id)?.url || '',
    line: (nodes.get(id)?.lineNumber ?? -1) + 1,
})).sort((a, b) => b.ms - a.ms).slice(0, 30);
process.stdout.write(JSON.stringify({ seconds, samples: profile.samples.length, top: rows }, null, 2) + '\n');
