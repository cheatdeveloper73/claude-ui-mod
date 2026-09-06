import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dirArg = process.argv.indexOf('--router-dir');
if (dirArg !== -1 && !process.argv[dirArg + 1]) throw new Error('--router-dir requires a path');
const routerDir = dirArg === -1
    ? fileURLToPath(new URL('../router/', import.meta.url))
    : path.resolve(process.argv[dirArg + 1]);
const { ResponsesToAnthropic, anthropicPing, collectAnthropicMessage, sseParser } = await import(pathToFileURL(path.join(routerDir, 'openai.mjs')).href);
const { anthropicSummaryResponse, collectRemoteCompaction, isClaudeCompactionRequest } = await import(pathToFileURL(path.join(routerDir, 'compaction.mjs')).href);

function invariant(value, message)
{
    if (!value) throw new Error(`router canary failed: ${message}`);
}

function fixture()
{
    return [
        { type: 'response.created', response: { usage: { input_tokens: 8, output_tokens: 0 } } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_canary' } },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'summary' },
        { type: 'response.reasoning_text.delta', output_index: 0, delta: 'provider text' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_canary', encrypted_content: 'canary-replay' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_canary', name: 'Read' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file_path":"canary"}' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_canary', name: 'Read' } },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 5 } } },
    ];
}

export function runRouterCanary()
{
    const frames = [];
    const translator = new ResponsesToAnthropic('claude-gpt-5.6-sol[1m]', frame => frames.push(frame), { showReasoningText: true });
    for (const event of fixture()) translator.handle(event);

    const events = [];
    const parse = sseParser(event => events.push(event));
    for (const frame of frames) parse(frame);

    invariant(events[0]?.type === 'message_start', 'stream does not start with message_start');
    invariant(events.at(-1)?.type === 'message_stop', 'stream does not end with message_stop');
    invariant(!events.some(event => event.type === 'error'), 'valid fixture emitted an error event');
    invariant(events.some(event => event.delta?.type === 'thinking_delta' && event.delta.thinking.includes('provider text')), 'provider reasoning path did not execute');
    invariant(events.some(event => event.content_block?.type === 'tool_use' && event.content_block.name === 'Read'), 'tool-use path did not execute');

    const opened = events.filter(event => event.type === 'content_block_start').map(event => event.index);
    const closed = events.filter(event => event.type === 'content_block_stop').map(event => event.index);
    invariant(JSON.stringify(opened) === JSON.stringify(closed), 'content block lifecycle is unbalanced');
    const thinkingBlocks = events.filter(event => event.content_block?.type === 'thinking').length;
    const signatures = events.filter(event => event.delta?.type === 'signature_delta').length;
    invariant(thinkingBlocks === signatures, 'a thinking block has no replay signature');

    const framed = [];
    const feed = sseParser(event => framed.push(event));
    feed('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
    feed('event: response.completed\ndata: {"type":"response.completed"}', true);
    invariant(framed.length === 2, 'CRLF or final unterminated SSE frame was dropped');

    const emptyFrames = [];
    const empty = new ResponsesToAnthropic('claude-gpt-5.6-sol[1m]', frame => emptyFrames.push(frame));
    empty.handle({ type: 'response.created', response: {} });
    empty.handle({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } });
    const emptyEvents = [];
    const parseEmpty = sseParser(event => emptyEvents.push(event));
    for (const frame of emptyFrames) parseEmpty(frame);
    invariant(emptyEvents.at(-1)?.type === 'error' && !emptyEvents.some(event => event.type === 'message_stop'), 'empty completion was accepted');

    const recoveredFrames = [];
    const recovered = new ResponsesToAnthropic('claude-gpt-5.6-sol[1m]', frame => recoveredFrames.push(frame));
    for (const event of fixture().slice(0, -1)) recovered.handle(event);
    invariant(recovered.recoverTransport(), 'a completed tool call was not recoverable after transport loss');
    const recoveredEvents = [];
    const parseRecovered = sseParser(event => recoveredEvents.push(event));
    for (const frame of recoveredFrames) parseRecovered(frame);
    invariant(recoveredEvents.at(-1)?.type === 'message_stop' && !recoveredEvents.some(event => event.type === 'error'), 'tool recovery did not terminate cleanly');

    const pingEvents = [];
    sseParser(event => pingEvents.push(event))(anthropicPing(), true);
    invariant(pingEvents[0]?.type === 'ping', 'heartbeat is not a valid Anthropic SSE event');

    const message = collectAnthropicMessage('claude-gpt-5.6-sol[1m]', fixture(), { showReasoningText: true });
    invariant(message.content.some(block => block.type === 'thinking'), 'nonstream reasoning is missing');
    invariant(message.content.some(block => block.type === 'tool_use' && block.name === 'Read'), 'nonstream tool use is missing');
    invariant(message.stop_reason === 'tool_use', 'nonstream stop reason is wrong');

    const compactPrompt = 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.';
    invariant(isClaudeCompactionRequest({ messages: [{ role: 'user', content: compactPrompt }] })?.kind === 'full', 'Claude compaction request is not recognized');
    const compact = collectRemoteCompaction([
        { type: 'response.output_item.done', item: { type: 'compaction', id: 'cmp_canary', encrypted_content: 'opaque' } },
        { type: 'response.completed', response: { id: 'resp_compact_canary' } },
    ]);
    invariant(compact.item.encrypted_content === 'opaque', 'Codex compaction item is not preserved');
    const summaryWire = anthropicSummaryResponse('claude-gpt-5.6-sol[1m]', 'checkpoint', { input_tokens: 1, output_tokens: 1 }, true);
    invariant(summaryWire.includes('event: message_start') && summaryWire.includes('event: message_stop'), 'compaction summary lifecycle is incomplete');

    return { ok: true, checks: 17 };
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint)
{
    try { process.stdout.write(JSON.stringify(runRouterCanary()) + '\n'); }
    catch (error)
    {
        process.stderr.write(String(error?.stack || error) + '\n');
        process.exitCode = 1;
    }
}
