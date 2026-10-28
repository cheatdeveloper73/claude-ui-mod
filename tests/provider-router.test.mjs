// Real router, three local upstreams, synthetic credentials. No paid API calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-router-test-'));
const token = 'e30.' + Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400})).toString('base64url') + '.test';
const auth = path.join(temp, 'auth.json');
fs.writeFileSync(auth, JSON.stringify({tokens:{access_token:token,account_id:'test-only',refresh_token:'test'},last_refresh:new Date().toISOString()}));
const calls = [];
let splitFraming = false;
let failClaude = false;
let failOpenAI = false;
let openAIStreamMode = 'complete';
let failStub = false;
let failStubCount = false;
const upstream = http.createServer((req,res) => {
    const chunks=[];
    req.on('data', c=>chunks.push(c));
    req.on('end', () => {
        const raw=Buffer.concat(chunks).toString();
        let body={};try{body=JSON.parse(raw)}catch{}
        calls.push({path:req.url,raw,body,headers:req.headers});
        if(req.url === '/stub/messages/count_tokens' || req.url === '/stub-next/messages/count_tokens') {
            if(failStubCount) {res.writeHead(429,{'content-type':'application/json','retry-after':'31'});res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Stub count unavailable"}}');return;}
            res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":321}');return;
        }
        if(req.url === '/stub/messages' || req.url === '/stub-next/messages') {
            if(failStub) {res.writeHead(429,{'content-type':'application/json','retry-after':'29'});res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Stub quota exhausted"}}');return;}
            const msg={id:'msg_stub_fixture',type:'message',role:'assistant',model:'stub-compat-1',content:[{type:'text',text:'MOCK_COMPAT 🐉'}],stop_reason:'end_turn',usage:{input_tokens:12,output_tokens:3}};
            if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(msg));return;}
            res.setHeader('content-type','text/event-stream');
            const events=[{type:'message_start',message:{...msg,content:[]}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'MOCK_COMPAT 🐉'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_stop'}];
            if(splitFraming){const bytes=Buffer.from(events.map(e=>'event: '+e.type+'\r\ndata: '+JSON.stringify(e)+'\r\n\r\n').join(''));
                // Split framing and UTF-8 at arbitrary byte boundaries.
                for(let i=0;i<bytes.length;i+=7)res.write(bytes.subarray(i,i+7));res.end();return;}
            res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));return;
        }
        if(req.url.startsWith('/anthropic')) {
            if(failClaude) {res.writeHead(429,{'content-type':'application/json','retry-after':'19'});res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Claude quota exhausted"}}');return;}
            res.setHeader('content-type','application/json');res.end('{"passthrough":true}');return;
        }
        if(req.url.startsWith('/models?')) {
            const token_budget={enabled:false,use_history_notes_extension:false,reminder_threshold_tokens:500,auto_compact_fallback_buffer_tokens:2000,reminder_message_template:'<context_window_reminder>Only {n_remaining} tokens remain. Save notes, then call new_context.</context_window_reminder>',guidance_message:'Use notes for long tasks. Treat notes and history as internal bookkeeping. Do not mention them in user-facing messages.',auto_compact_fallback_prompt:'<context_window_reminder>Budget exhausted. Save notes, then call new_context.</context_window_reminder>'};
            res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{slug:'gpt-5.6-sol',max_context_window:100000,effective_context_window_percent:100,model_messages:{token_budget}}]}));return;
        }
        if(req.url === '/responses') {
            const contextContinuation=body.input?.some(item=>item?.type==='function_call_output'&&item.call_id==='ctx_fixture');
            if(failOpenAI||(openAIStreamMode==='context-round-failed'&&contextContinuation)) {res.writeHead(429,{'content-type':'application/json','retry-after':'23'});res.end('{"error":{"message":"OpenAI quota exhausted"}}');return;}
            res.setHeader('content-type','text/event-stream');
            const contextFirst=openAIStreamMode.startsWith('context-round')&&!contextContinuation;
            const responseId=contextContinuation?'resp_context_final':contextFirst?'resp_context_hidden':'resp_fixture';
            const created={type:'response.created',response:{id:responseId,model:'reported-model-fixture',reasoning:{effort:'low'},usage:{input_tokens:10,output_tokens:0}}};
            const compacting=body.input?.at(-1)?.type==='compaction_trigger';
            const renderingFallback=body.input?.some(item=>item?.type==='compaction')&&body.input?.at(-1)?.type==='message';
            const compactItem={type:'compaction',id:'cmp_fixture',encrypted_content:openAIStreamMode==='compact-whitespace'?'   ':'encrypted-checkpoint-fixture'};
            const fallbackText=openAIStreamMode==='fallback-empty'?'   ':'Portable checkpoint summary with PROJECT-729.';
            const contextCall={type:'function_call',call_id:'ctx_fixture',name:'new_context'};
            const complete=contextFirst
                ? [created,{type:'response.output_item.added',output_index:0,item:contextCall},{type:'response.function_call_arguments.delta',output_index:0,delta:'{}'},{type:'response.output_item.done',output_index:0,item:contextCall},{type:'response.completed',response:{id:'resp_context_hidden',model:body.model,usage:{input_tokens:90,output_tokens:4}}}]
                : compacting
                    ? [created,{type:'response.output_item.added',output_index:0,item:compactItem},{type:'response.output_item.done',output_index:0,item:compactItem},{type:'response.completed',response:{id:'resp_compact_fixture',model:body.model,usage:{input_tokens:100,output_tokens:12}}}]
                    : [created,{type:'response.output_item.added',output_index:0,item:{type:'message'}},{type:'response.output_text.delta',output_index:0,delta:renderingFallback?fallbackText:'MOCK_OPENAI'},{type:'response.output_item.done',output_index:0,item:{type:'message'}},{type:'response.completed',response:{id:renderingFallback?'resp_fallback_fixture':responseId,model:'reported-model-fixture',reasoning:{effort:'low'},usage:{input_tokens:contextContinuation?12:10,output_tokens:2}}}];
            const fallbackFailed=openAIStreamMode==='fallback-failed'&&renderingFallback;
            const failed=openAIStreamMode==='failed'||openAIStreamMode==='content-failed'||openAIStreamMode==='invalid-prompt-failed'||fallbackFailed;
            const failure=fallbackFailed
                ? {message:'fixture fallback failure'}
                : openAIStreamMode==='content-failed'
                    ? {code:'invalid_prompt',message:'This content was flagged for possible cybersecurity risk.'}
                    : openAIStreamMode==='invalid-prompt-failed'
                        ? {code:'invalid_prompt',message:'Fixture prompt is invalid.'}
                        : {message:'fixture stream failure'};
            const events=failed?[created,{type:'response.failed',response:{error:failure}}]:openAIStreamMode==='truncated'?[created]:complete;
            const newline=openAIStreamMode==='crlf'?'\r\n':'\n';
            const text=events.map(e=>'event: '+e.type+newline+'data: '+JSON.stringify(e)+newline+newline).join('');
            res.end(openAIStreamMode==='unterminated'?text.trimEnd():text);return;
        }
        res.writeHead(404);res.end();
    });
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+upstream.address().port;
const catalogueFile=path.join(temp,'catalogue.json');
const secretsFile=path.join(temp,'provider-secrets.json');
const stubModel=(baseUrl=base+'/stub')=>({id:'Stub-Compat-agent',name:'Stub Compat Agent',efforts:[],provider:'stub',backend:{protocol:'anthropic-messages',baseUrl,apiKeyHeader:'x-api-key',secret:'stub'}});
fs.writeFileSync(catalogueFile,JSON.stringify([stubModel()]));
fs.writeFileSync(secretsFile,JSON.stringify({stub:{apiKey:'stub-test-key-one'}}));
const adapterDir=path.join(temp,'no-adapters');fs.mkdirSync(adapterDir,{recursive:true});
// A missing authority file keeps this suite off the live credential view.
Object.assign(process.env,{MODEL_ROUTER_AUTHORITY_FILE:path.join(temp,'no-credential-authority.json'),CODEX_AUTH_FILE:auth,CODEX_RESPONSES_URL:base+'/responses',MODEL_ROUTER_UPSTREAM:base+'/anthropic',MODEL_ROUTER_ADAPTER_DIR:adapterDir,MODEL_ROUTER_STATE_DIR:temp,MODEL_ROUTER_BYPASS_SESSIONS_FILE:path.join(temp,'bypass-sessions.json'),MODEL_ROUTER_SETTINGS_FILE:path.join(temp,'settings.json'),MODEL_ROUTER_CATALOGUE_FILE:catalogueFile,MODEL_ROUTER_SECRETS_FILE:secretsFile});
const {compactionStore,server,windowStore}=await import(pathToFileURL(path.join(root,'index.mjs')));
const {bypassSessionsFile,filterBypassSafeguardContext,readBypassSessions}=await import(pathToFileURL(path.join(root,'bypass-context.mjs')));
const {estimateOpenAIInput}=await import(pathToFileURL(path.join(root,'count-tokens.mjs')));
const SAFEGUARD_COMPANION='Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.';
const INTERRUPTED_SAFEGUARD_COMPANION=SAFEGUARD_COMPANION+' Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.';
const NEUTRAL_CONTINUATION='Continue.';
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint='http://127.0.0.1:'+server.address().port;
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
async function send(body, sid='573cf3ba-87d3-4bd2-8f56-ea1b4446f72d') {
    return fetch(endpoint+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':sid},body:typeof body==='string'?body:JSON.stringify({max_tokens:2000,messages:[{role:'user',content:'test'}],...body})});
}
async function textAtMost(target) {
    let low=0,high=target*2,best={text:'',tokens:0};
    while(low<=high){const mid=Math.floor((low+high)/2);const text='x '.repeat(mid);const tokens=await estimateOpenAIInput({model:'gpt-5.6-sol',instructions:'',input:[{type:'message',role:'user',content:[{type:'input_text',text}]},{type:'message',role:'user',content:[{type:'input_text',text:'current'}]}]});if(tokens<=target){best={text,tokens};low=mid+1;}else high=mid-1;}
    return best;
}
try {
    const helperSid='12345678-1234-4234-8234-123456789abc';
    const helperBody={tools:[{name:'read_file'}],messages:[{role:'user',content:SAFEGUARD_COMPANION}]};
    check('bypass context helper matches only exact agent companions',()=>{
        const active=new Set([helperSid]);
        assert.equal(filterBypassSafeguardContext(helperBody,helperSid,active).body.messages[0].content,NEUTRAL_CONTINUATION);
        const interrupted={...helperBody,messages:[{role:'user',content:[{type:'text',text:INTERRUPTED_SAFEGUARD_COMPANION,cache_control:{type:'ephemeral'}}]}]};
        assert.deepEqual(filterBypassSafeguardContext(interrupted,helperSid,active).body.messages[0].content,[{type:'text',text:NEUTRAL_CONTINUATION,cache_control:{type:'ephemeral'}}]);
        const near={...helperBody,messages:[{role:'user',content:'Prefix: '+SAFEGUARD_COMPANION}]};
        assert.equal(filterBypassSafeguardContext(near,helperSid,active).body,near);
        const control={...helperBody,tools:[]};
        assert.equal(filterBypassSafeguardContext(control,helperSid,active).body,control);
        assert.equal(filterBypassSafeguardContext(helperBody,'other',active).body,helperBody);
    });
    check('bypass registry path and expiry fail closed',()=>{
        const explicit=process.env.MODEL_ROUTER_BYPASS_SESSIONS_FILE;
        const state=process.env.MODEL_ROUTER_STATE_DIR;
        delete process.env.MODEL_ROUTER_BYPASS_SESSIONS_FILE;
        process.env.MODEL_ROUTER_STATE_DIR=path.join(temp,'unrelated-state');
        assert.equal(bypassSessionsFile(),path.resolve(root,'..','.state','bypass-sessions.json'));
        process.env.MODEL_ROUTER_BYPASS_SESSIONS_FILE=explicit;
        if(state===undefined)delete process.env.MODEL_ROUTER_STATE_DIR;else process.env.MODEL_ROUTER_STATE_DIR=state;
        fs.writeFileSync(explicit,JSON.stringify({version:1,expiresAt:2000,sessions:[helperSid.toUpperCase()]}));
        assert.deepEqual([...readBypassSessions(explicit,1000)],[helperSid]);
        assert.equal(readBypassSessions(explicit,2000).size,0);
    });
    for(const [slug,effort] of [['gpt-5.6-sol','max'],['gpt-5.6-luna','xhigh'],['gpt-5.5','high']]) {
        const model='claude-'+slug+'[1m]';
        const res=await send({model,stream:true,output_config:{effort}});const text=await res.text();const call=calls.at(-1);
        check(slug+' native effort reaches Responses',()=>{assert.equal(call.body.model,slug);assert.equal(call.body.reasoning.effort,effort);assert.equal(res.status,200);assert.equal(res.headers.get('x-cuimod-prompt-policy-id'),'preserve');assert.equal(res.headers.get('x-cuimod-prompt-policy-generation'),'1');assert.ok(text.includes(model));assert.ok(text.includes('MOCK_OPENAI'));assert.ok(text.includes('message_stop'));assert.equal(call.body.max_output_tokens,undefined);});
    }
    const bypassContextSid='12345678-1234-4234-8234-123456789abc';
    const ordinaryContextSid='abcdefab-cdef-4abc-8def-abcdefabcdef';
    const refusalMessages=[{role:'user',content:'Original request'},
        {role:'assistant',content:[{type:'text',text:'Partial answer'}]},
        {role:'user',content:SAFEGUARD_COMPANION}];
    fs.writeFileSync(path.join(temp,'bypass-sessions.json'),JSON.stringify({version:1,expiresAt:Date.now()+60000,sessions:[bypassContextSid]}));
    await (await send({model:'claude-opus-5',stream:false,messages:refusalMessages,tools:[{name:'read_file',input_schema:{type:'object'}}]},bypassContextSid)).text();
    check('bypass strips the safeguard companion before native Anthropic forwarding',()=>{const sent=calls.at(-1);assert.equal(sent.path,'/anthropic/v1/messages');assert.equal(sent.body.messages.at(-1).content,NEUTRAL_CONTINUATION);assert.equal(JSON.stringify(sent.body).includes(SAFEGUARD_COMPANION),false);});
    await (await send({model:'claude-opus-5',stream:false,messages:refusalMessages,tools:[{name:'read_file',input_schema:{type:'object'}}]},ordinaryContextSid)).text();
    check('non-bypass Anthropic context remains byte-equivalent',()=>{const sent=calls.at(-1);assert.equal(sent.body.messages.at(-1).content,SAFEGUARD_COMPANION);});
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:refusalMessages,tools:[{name:'read_file',input_schema:{type:'object'}}]},bypassContextSid)).text();
    check('bypass strips the safeguard companion before Responses translation',()=>{const sent=calls.at(-1);const input=JSON.stringify(sent.body.input);const users=sent.body.input.filter(item=>item?.type==='message'&&item.role==='user');assert.equal(input.includes(SAFEGUARD_COMPANION),false);assert.equal(users.at(-1)?.content?.at(-1)?.text,NEUTRAL_CONTINUATION);});
    await (await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':bypassContextSid},body:JSON.stringify({model:'claude-opus-5',messages:refusalMessages,tools:[{name:'read_file',input_schema:{type:'object'}}]})})).text();
    check('bypass strips the safeguard companion before native token counting',()=>{const sent=calls.at(-1);assert.equal(sent.path,'/anthropic/v1/messages/count_tokens');assert.equal(sent.body.messages.at(-1).content,NEUTRAL_CONTINUATION);});
    check('identity diagnostics use upstream metadata, not the requested label',()=>{const log=fs.readFileSync(path.join(temp,'bridge.log'),'utf8');assert.ok(log.includes('"reportedModel":"reported-model-fixture"'));assert.ok(log.includes('"requestedModel":"gpt-5.6-sol"'));assert.ok(log.includes('"reportedEffort":"low"'));assert.equal(log.includes(token),false);});
    const settingsFile=process.env.MODEL_ROUTER_SETTINGS_FILE;
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'detailed',logUpstreamIdentity:false}}));
    const logBefore=fs.readFileSync(path.join(temp,'bridge.log'),'utf8').split('openai-response-identity').length;
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,output_config:{effort:'high'}})).text();
    check('dashboard changes affect the next request without restarting',()=>{assert.equal(calls.at(-1).body.reasoning.summary,'detailed');assert.equal(calls.at(-1).body.reasoning.effort,'high');assert.equal(fs.readFileSync(path.join(temp,'bridge.log'),'utf8').split('openai-response-identity').length,logBefore);});
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'off'}}));
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true})).text();
    check('summary off preserves encrypted reasoning replay',()=>{assert.equal(calls.at(-1).body.reasoning.summary,undefined);assert.deepEqual(calls.at(-1).body.include,['reasoning.encrypted_content']);});
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningEnabled:false,reasoningSummary:'detailed'}}));
    const noReasoning=await send({model:'claude-gpt-5.4[1m]',stream:true,output_config:{effort:'max'}});const noReasoningText=await noReasoning.text();
    check('reasoning off sends native none and exposes a zero hidden-token split',()=>{const sent=calls.at(-1).body;assert.equal(noReasoning.status,200);assert.deepEqual(sent.reasoning,{effort:'none'});assert.equal(sent.include,undefined);assert.ok(noReasoningText.includes('"thinking_tokens":0'));});

    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'context-management':{enabled:true,notesTools:false,historyTools:true,reminders:false,windowReset:true}}));
    const identitySids=['11111111-2222-4333-8444-555555555555','66666666-7777-4888-8999-aaaaaaaaaaaa'];
    const identityStart=calls.filter(call=>call.path==='/responses').length;
    for(const sid of identitySids) await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Identical first turn.'}]},sid)).text();
    check('identical prompts keep isolated session, thread, and ingest identities',()=>{
        const sent=calls.filter(call=>call.path==='/responses').slice(identityStart);assert.equal(sent.length,2);
        for(let index=0;index<sent.length;index++){const call=sent[index];const store=windowStore.read(identitySids[index]).storeId;assert.equal(call.headers['session-id'],store);assert.equal(call.headers['thread-id'],store);assert.equal(call.body.client_metadata.session_id,store);assert.equal(call.body.client_metadata.thread_id,store);}
        assert.notEqual(sent[0].headers['session-id'],sent[1].headers['session-id']);
    });
    const sharedParentSid=identitySids[0];
    const parentStore=windowStore.read(sharedParentSid);
    const parentTurns=parentStore.activity.turns;
    const subagentStart=calls.filter(call=>call.path==='/responses').length;
    const identicalWorker={model:'claude-gpt-5.6-sol[1m]',stream:true,system:'x-anthropic-billing-header: cc_is_subagent=true',messages:[{role:'user',content:'Independent worker turn.'}]};
    await (await send(identicalWorker,sharedParentSid)).text();
    await (await send(identicalWorker,sharedParentSid)).text();
    await (await send({...identicalWorker,messages:[{role:'user',content:'A different worker turn.'}]},sharedParentSid)).text();
    await (await send(identicalWorker,identitySids[1])).text();
    check('subagent traffic cannot enter or mutate the parent context lane',()=>{
        const sent=calls.filter(call=>call.path==='/responses').slice(subagentStart);assert.equal(sent.length,4);
        for(const call of sent){assert.equal(JSON.stringify(call.body.input).includes('<context_window>'),false);assert.equal(call.body.client_metadata,undefined);assert.equal(call.body.tools,undefined);assert.notEqual(call.headers['session-id'],parentStore.storeId);assert.equal(call.headers['thread-id'],call.headers['session-id']);}
        assert.equal(windowStore.read(sharedParentSid).activity.turns,parentTurns);
    });
    // The backend keeps cache affinity per thread. A worker's successive requests
    // must stay on one thread, and parallel workers must not pile onto the
    // parent's or each other's: a per-request id missed on every call, and the
    // shared session id raised misses to ~34% at six concurrent workers.
    check('each subagent conversation keeps one thread of its own',()=>{
        const sent=calls.filter(call=>call.path==='/responses').slice(subagentStart);
        assert.equal(sent[0].headers['session-id'],sent[1].headers['session-id']);
        assert.notEqual(sent[0].headers['session-id'],sent[2].headers['session-id']);
        assert.notEqual(sent[0].headers['session-id'],sent[3].headers['session-id']);
        assert.notEqual(sent[0].headers['session-id'],sharedParentSid);
    });

    const compactWrapper=`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.\n- You already have all the context you need in the conversation above.\n- Tool calls will be REJECTED and will waste your only turn — you will fail the task.\n- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\n`;
    const compactPrompt=compactWrapper+'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.\n\nPreserve everything important.';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'compaction-provider':{strategy:'codex',portableFallback:true,model:'current'},'context-management':{enabled:true,notesTools:true,historyTools:true,reminders:true,windowReset:true}}));
    const subCompactCalls=calls.filter(call=>call.path==='/responses').length;
    const parentWindows=windowStore.status(sharedParentSid).windows;
    const subCompact=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,system:'x-anthropic-billing-header: cc_is_subagent=true',messages:[{role:'user',content:'Worker history.'},{role:'user',content:compactPrompt}]},sharedParentSid);await subCompact.text();
    check('subagent compaction cannot rotate the parent context window',()=>{assert.equal(subCompact.headers.get('x-cuimod-compaction'),null);assert.equal(calls.filter(call=>call.path==='/responses').length,subCompactCalls+1);assert.equal(windowStore.status(sharedParentSid).windows,parentWindows);});

    const resetSid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'compaction-provider':{strategy:'codex',portableFallback:true,model:'current'},'context-management':{enabled:true,notesTools:false,historyTools:false,reminders:false,windowReset:true}}));
    const resetCallsBefore=calls.length;
    const resetBody={model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Old window prefix.'},{role:'user',content:'The project marker is PROJECT-729.'},{role:'assistant',content:[{type:'text',text:'Working on it.'}]},{role:'user',content:compactPrompt}]};
    const resetResponse=await send(resetBody,resetSid);
    const resetText=await resetResponse.text();
    const resetMarker=/\[\[cuimod:context-reset:v1:([0-9a-f-]{36})\]\]/.exec(resetText);
    check('context-managed compaction resets locally without an inference call',()=>{
        assert.equal(resetResponse.status,200);assert.equal(resetResponse.headers.get('x-cuimod-compaction'),'context-window-reset');assert.ok(resetMarker);assert.equal(calls.length,resetCallsBefore);
        const state=windowStore.status(resetSid);assert.equal(state.windows,2);assert.equal(state.pendingClientReset,true);assert.equal(state.activity.compactionResets,1);
    });
    const retryResponse=await send(resetBody,resetSid);const retryText=await retryResponse.text();
    check('a retried compaction response reuses one reset',()=>{assert.ok(retryText.includes(resetMarker[0]));assert.equal(windowStore.status(resetSid).windows,2);assert.equal(windowStore.status(resetSid).activity.compactionResets,1);});
    const wrappedReset='This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n'+resetMarker[0];
    const resetCountCalls=calls.length;
    const resetCount=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':resetSid},body:JSON.stringify({model:'claude-gpt-5.6-sol[1m]',messages:[{role:'user',content:wrappedReset},{role:'user',content:'Count the clean window.'}]})});
    check('token counting strips a pending reset marker without consuming it',()=>{assert.equal(resetCount.status,200);assert.equal(calls.length,resetCountCalls);assert.equal(windowStore.status(resetSid).pendingClientReset,true);});
    failOpenAI=true;
    const failedRestore=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:wrappedReset},{role:'user',content:'Continue after a retryable failure.'}]},resetSid);
    await failedRestore.text();
    failOpenAI=false;
    check('a failed restoring turn leaves its reset acknowledgement retryable',()=>{
        assert.equal(failedRestore.status,429);assert.equal(windowStore.status(resetSid).pendingClientReset,true);
    });
    const resetResponsesBefore=calls.filter(call=>call.path==='/responses').length;
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:wrappedReset},{role:'user',content:'Continue the work.'}]},resetSid)).text();
    check('the next GPT turn consumes the reset marker and starts clean',()=>{
        const responseCalls=calls.filter(call=>call.path==='/responses');assert.equal(responseCalls.length,resetResponsesBefore+1);const input=responseCalls.at(-1).body.input;assert.equal(JSON.stringify(input).includes('cuimod:context-reset'),false);assert.equal(JSON.stringify(input).includes('being continued from a previous conversation'),false);assert.equal(windowStore.status(resetSid).pendingClientReset,false);assert.equal(windowStore.status(resetSid).cutUserMessages,null);
    });
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:wrappedReset},{role:'user',content:'Replay the acknowledged turn.'}]},resetSid)).text();
    check('an acknowledged reset marker remains safe on client replay',()=>{
        const input=calls.filter(call=>call.path==='/responses').at(-1).body.input;assert.equal(JSON.stringify(input).includes('cuimod:context-reset'),false);assert.equal(JSON.stringify(input).includes('being continued from a previous conversation'),false);
    });
    const claudeAfterReset=await send({model:'claude-opus-5',stream:false,messages:[{role:'user',content:wrappedReset},{role:'user',content:'Continue portably.'}]},resetSid);await claudeAfterReset.text();
    check('context reset markers never leak to a non-OpenAI provider',()=>{const sent=JSON.stringify(calls.at(-1).body);assert.equal(sent.includes('cuimod:context-reset'),false);assert.equal(sent.includes('being continued from a previous conversation'),false);});

    const cutCountSid='acacacac-bdbd-cece-dfdf-010101010101';
    const oldCountText='retired-prefix '.repeat(5000);
    windowStore.rotate(cutCountSid,[{type:'message',role:'user',content:[{type:'input_text',text:oldCountText}]}]);
    const cutCountCalls=calls.length;
    const cutCountResponse=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':cutCountSid},body:JSON.stringify({model:'claude-gpt-5.6-sol[1m]',messages:[{role:'user',content:oldCountText},{role:'user',content:'Count only this turn.'}]})});
    const cutCount=await cutCountResponse.json();
    check('token counting uses the same clean window as inference',()=>{assert.equal(cutCountResponse.status,200);assert.equal(calls.length,cutCountCalls);assert.ok(cutCount.input_tokens<100);assert.equal(windowStore.status(cutCountSid).cutUserMessages,1);});
    const subCountResponse=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':cutCountSid},body:JSON.stringify({model:'claude-gpt-5.6-sol[1m]',system:'x-anthropic-billing-header: cc_is_subagent=true',messages:[{role:'user',content:oldCountText},{role:'user',content:'Count the worker transcript.'}]})});
    const subCount=await subCountResponse.json();
    check('parent window cuts never alter subagent token counts',()=>{assert.equal(subCountResponse.status,200);assert.ok(subCount.input_tokens>1000);assert.equal(windowStore.status(cutCountSid).cutUserMessages,1);});

    const budgetSid='abababab-cdcd-efef-1212-343434343434';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'context-management':{enabled:true,notesTools:false,historyTools:false,reminders:true,windowReset:true},'auto-compact':{enabled:true,perModel:{'gpt-5.6-sol':100000}}}));
    const reminderInput=await textAtMost(64600);
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:reminderInput.text},{role:'user',content:'current'}]},budgetSid)).text();
    check('the reminder follows the configured Claude Code trigger',()=>{const sent=JSON.stringify(calls.filter(call=>call.path==='/responses').at(-1).body.input);assert.ok(sent.includes('tokens remain. Save notes'));assert.equal(sent.includes('Budget exhausted'),false);});
    const fallbackInput=await textAtMost(65500);
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:fallbackInput.text},{role:'user',content:'current'}]},budgetSid)).text();
    check('the fallback prompt occupies the protected pre-compaction buffer',()=>{const sent=JSON.stringify(calls.filter(call=>call.path==='/responses').at(-1).body.input);assert.ok(sent.includes('Budget exhausted. Save notes'));const budget=windowStore.status(budgetSid).activity.budget;assert.equal(budget.remaining,0);assert.ok(budget.forceRemaining>0);});
    const forceInput=await textAtMost(67500);
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:forceInput.text},{role:'user',content:'current'}]},budgetSid)).text();
    check('the buffered boundary forces a clean window before inference',()=>{const sent=JSON.stringify(calls.filter(call=>call.path==='/responses').at(-1).body.input);assert.equal(sent.includes(forceInput.text.slice(0,100)),false);assert.ok(sent.includes('current'));const state=windowStore.status(budgetSid);assert.equal(state.windows,2);assert.equal(state.activity.forcedResets,1);assert.ok(state.activity.budget.remaining>60000);});

    const identityCompactSid='bcbcbcbc-cdcd-dede-efef-010101010101';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'compaction-provider':{strategy:'codex',portableFallback:true,model:'current'},'context-management':{enabled:true,notesTools:false,historyTools:false,reminders:false,windowReset:false}}));
    const identityCompactStart=calls.length;
    const identityCompact=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Context identity prefix.'},{role:'user',content:compactPrompt}]},identityCompactSid);await identityCompact.text();
    check('remote compaction shares the root context backend identity',()=>{const storeId=windowStore.read(identityCompactSid).storeId;assert.equal(identityCompact.headers.get('x-cuimod-compaction'),'codex-v2');assert.equal(calls[identityCompactStart].headers['session-id'],storeId);assert.equal(calls[identityCompactStart+1].headers['session-id'],storeId);});

    const roundSid='acbdacbd-bdce-cedf-dfe0-121212121212';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'context-management':{enabled:true,notesTools:false,historyTools:false,reminders:false,windowReset:true},'auto-compact':{enabled:true,perModel:{'gpt-5.6-sol':100000}}}));
    openAIStreamMode='context-round';const roundCallsBefore=calls.length;const roundResponse=await send({model:'claude-gpt-5.6-sol[1m]',stream:false,messages:[{role:'user',content:'Continue through a model-only window call.'}]},roundSid);const roundBody=await roundResponse.json();
    const roundHistory=await(await fetch(endpoint+'/throughput/api?session='+roundSid)).json();
    check('a nonstream model-only round preserves arguments and attributes usage to the final answer',()=>{
        assert.equal(roundResponse.status,200);assert.equal(roundBody.content[0].text,'MOCK_OPENAI');assert.equal(calls.length,roundCallsBefore+2);
        const replayed=calls.at(-1).body.input.find(item=>item?.type==='function_call'&&item.call_id==='ctx_fixture');assert.equal(replayed.arguments,'{}');
        assert.equal(roundHistory.records.at(-1).responseId,'resp_context_final');assert.equal(roundHistory.records.at(-1).tokens.outputTokens,2);
    });
    const failedRoundSid='adceadce-cedf-dfe0-e0f1-232323232323';
    openAIStreamMode='context-round-failed';const failedRoundBefore=calls.length;const failedRound=await send({model:'claude-gpt-5.6-sol[1m]',stream:false,messages:[{role:'user',content:'Preserve the second-round error.'}]},failedRoundSid);const failedRoundBody=await failedRound.json();
    check('a nonstream model-only continuation preserves the real upstream failure',()=>{assert.equal(failedRound.status,429);assert.equal(failedRound.headers.get('retry-after'),'23');assert.equal(failedRoundBody.error.type,'rate_limit_error');assert.equal(calls.length,failedRoundBefore+2);});
    openAIStreamMode='complete';

    const compactSid='bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'compaction-provider':{strategy:'codex',portableFallback:true,model:'current'},'context-management':{enabled:false}}));
    const legacySid='bdbdbdbd-cece-dfdf-8989-020202020202';
    const legacyState=windowStore.ensure(legacySid);const legacyResetId='03030303-1414-4545-8686-070707070707';
    windowStore.write({...legacyState,agentIsolationVersion:undefined,clientReset:{id:legacyResetId,cut:null},cut:{userMessages:1,digest:'mixed-agent-cut'}});
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Legacy wrapper survives quarantine. [[cuimod:context-reset:v1:'+legacyResetId+']]'},{role:'user',content:'Current root turn.'}]},legacySid)).text();
    check('a disabled context lane quarantines legacy state before restoration',()=>{const call=calls.filter(value=>value.path==='/responses').at(-1);const migrated=windowStore.read(legacySid);assert.ok(JSON.stringify(call.body.input).includes('Legacy wrapper survives quarantine.'));assert.notEqual(migrated.storeId,legacyState.storeId);assert.equal(migrated.quarantinedStoreId,legacyState.storeId);assert.equal(migrated.clientReset,null);assert.equal(migrated.cut,null);});
    const compactCallsBefore=calls.length;
    const compactResponse=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Old window prefix.'},{role:'user',content:'The project marker is PROJECT-729.'},{role:'assistant',content:[{type:'text',text:'Working on it.'}]},{role:'user',content:compactPrompt}]},compactSid);
    const compactText=await compactResponse.text();
    const marker=/\[\[cuimod:codex-compact:v1:([A-Za-z0-9_-]{24})\]\]/.exec(compactText);
    check('GPT compaction still uses Codex V2 when context windows are disabled',()=>{
        assert.equal(compactResponse.status,200);assert.equal(compactResponse.headers.get('x-cuimod-compaction'),'codex-v2');assert.ok(marker);assert.ok(compactText.includes('Portable checkpoint summary with PROJECT-729.'));
        const compactCall=calls[compactCallsBefore];const fallbackCall=calls[compactCallsBefore+1];assert.equal(calls.length,compactCallsBefore+2);assert.equal(compactCall.body.input.at(-1).type,'compaction_trigger');assert.equal(fallbackCall.body.input[0].type,'compaction');assert.ok(fs.existsSync(path.join(temp,'compactions-v1',marker[1]+'.json')));
    });
    const wrappedSummary='This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n'+marker[0]+'\n\nPortable checkpoint summary with PROJECT-729.';
    const restoreCallsBefore=calls.filter(call=>call.path==='/responses').length;
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:wrappedSummary},{role:'user',content:'Continue the work.'}]},compactSid)).text();
    check('the next GPT turn restores opaque checkpoint state',()=>{const responseCalls=calls.filter(call=>call.path==='/responses');assert.equal(responseCalls.length,restoreCallsBefore+1);const input=responseCalls.at(-1).body.input;assert.ok(input.some(item=>item.type==='compaction'&&item.encrypted_content==='encrypted-checkpoint-fixture'));assert.equal(JSON.stringify(input).includes('cuimod:codex-compact'),false);});
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,system:'x-anthropic-billing-header: cc_is_subagent=true',messages:[{role:'user',content:wrappedSummary},{role:'user',content:'Worker continues independently.'}]},compactSid)).text();
    check('a subagent strips a parent checkpoint marker without restoring parent history',()=>{const call=calls.filter(value=>value.path==='/responses').at(-1);const input=JSON.stringify(call.body.input);assert.equal(call.body.input.some(item=>item.type==='compaction'),false);assert.equal(input.includes('encrypted-checkpoint-fixture'),false);assert.equal(input.includes('cuimod:codex-compact'),false);assert.notEqual(call.headers['session-id'],compactSid);});
    const status=await(await fetch(endpoint+'/compactionz?session='+compactSid)).json();
    check('compaction status exposes metadata without encrypted content',()=>{assert.equal(status.checkpoints.count,1);assert.equal(status.checkpoints.latest.sourceModel,'gpt-5.6-sol');assert.equal(JSON.stringify(status).includes('encrypted-checkpoint-fixture'),false);});

    const retiredCutSid='bcbcbcbc-cdcd-dede-efef-010101010101';
    const retiredPrefix='retired before compaction';
    const retiredState=windowStore.rotate(retiredCutSid,[{type:'message',role:'user',content:[{type:'input_text',text:retiredPrefix}]}]);
    const retiredCallsBefore=calls.length;
    const retiredCompact=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:retiredPrefix},{role:'user',content:'current after cut'},{role:'user',content:compactPrompt}]},retiredCutSid);
    const retiredText=await retiredCompact.text();
    const retiredMarker=/\[\[cuimod:codex-compact:v1:([A-Za-z0-9_-]{24})\]\]/.exec(retiredText);
    check('Codex compaction absorbs an existing router cut even when new context injection is off',()=>{
        const compactCall=calls[retiredCallsBefore];assert.ok(retiredMarker);assert.equal(JSON.stringify(compactCall.body.input).includes(retiredPrefix),false);assert.ok(JSON.stringify(compactCall.body.input).includes('current after cut'));
        const record=compactionStore.load(retiredMarker[1],retiredCutSid);assert.deepEqual(record.windowCut,retiredState.cut);
    });

    const failedCompactBody={model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'usable context'},{role:'user',content:compactPrompt}]};
    for(const [mode,sid,expectedCalls,label] of [
        ['fallback-empty','cdcdcdcd-dede-efef-0101-121212121212',2,'empty portable summary'],
        ['fallback-failed','dededede-efef-0101-1212-232323232323',2,'failed portable summary'],
        ['compact-whitespace','efefefef-0101-1212-2323-343434343434',1,'malformed encrypted checkpoint'],
    ]){
        openAIStreamMode=mode;const before=calls.length;const response=await send(failedCompactBody,sid);const text=await response.text();
        check(label+' fails closed without replacing context',()=>{assert.equal(response.status,502);assert.equal(response.headers.get('x-cuimod-compaction'),'failed');assert.equal(calls.length,before+expectedCalls);assert.equal(compactionStore.status(sid).count,0);assert.ok(text.includes('compaction failed'));});
    }
    openAIStreamMode='complete';
    failOpenAI=true;const limitedBefore=calls.length;const limitedCompact=await send(failedCompactBody,'f0f0f0f0-0101-1212-2323-454545454545');await limitedCompact.text();failOpenAI=false;
    check('provider compaction quota failures preserve their retry status',()=>{assert.equal(limitedCompact.status,429);assert.equal(limitedCompact.headers.get('retry-after'),'23');assert.equal(calls.length,limitedBefore+1);});

    fs.writeFileSync(settingsFile,JSON.stringify({'compaction-provider':{strategy:'native',portableFallback:true,model:'current'},'context-management':{enabled:false}}));
    const nativeCallsBefore=calls.length;
    const nativeCompact=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'Native path fixture.'},{role:'user',content:compactPrompt}]},'native-compact-session');await nativeCompact.text();
    check('native strategy leaves Claude Code compaction on the ordinary GPT turn',()=>{assert.equal(calls.length,nativeCallsBefore+1);assert.equal(calls.at(-1).body.input.some(item=>item.type==='compaction_trigger'),false);assert.equal(nativeCompact.headers.get('x-cuimod-compaction'),null);});
    fs.unlinkSync(settingsFile);
    openAIStreamMode='crlf';
    const crlfOpenAI=await send({model:'claude-gpt-5.6-sol[1m]',stream:true});
    const crlfOpenAIText=await crlfOpenAI.text();
    check('OpenAI accepts CRLF framed Responses events',()=>{assert.equal(crlfOpenAI.status,200);assert.ok(crlfOpenAIText.includes('MOCK_OPENAI'));assert.ok(crlfOpenAIText.includes('message_stop'));});
    openAIStreamMode='unterminated';
    const unterminatedOpenAI=await send({model:'claude-gpt-5.6-sol[1m]',stream:true});
    const unterminatedOpenAIText=await unterminatedOpenAI.text();
    check('OpenAI flushes a final event without a blank-line terminator',()=>{assert.equal(unterminatedOpenAI.status,200);assert.ok(unterminatedOpenAIText.includes('message_stop'));});
    openAIStreamMode='failed';
    const failedOpenAIStream=await send({model:'claude-gpt-5.6-sol[1m]',stream:true});
    const failedOpenAIStreamText=await failedOpenAIStream.text();
    check('OpenAI stream failures remain explicit in-band errors and are logged',()=>{assert.equal(failedOpenAIStream.status,200);assert.ok(failedOpenAIStreamText.includes('event: error'));assert.ok(failedOpenAIStreamText.includes('fixture stream failure'));assert.ok(fs.readFileSync(path.join(temp,'bridge.log'),'utf8').includes('openai response.failed on gpt-5.6-sol: fixture stream failure'));});
    const failedOpenAINonstream=await send({model:'claude-gpt-5.6-sol[1m]',stream:false});
    const failedOpenAINonstreamBody=await failedOpenAINonstream.json();
    check('OpenAI nonstream failures return a retryable status instead of empty HTTP 200',()=>{assert.equal(failedOpenAINonstream.status,502);assert.ok(failedOpenAINonstreamBody.error.message.includes('fixture stream failure'));});
    openAIStreamMode='content-failed';
    const blockedOpenAIStream=await send({model:'claude-gpt-6-astra[1m]',stream:true});
    const blockedOpenAIStreamText=await blockedOpenAIStream.text();
    check('OpenAI cybersecurity rejections use Claude Code native refusal framing',()=>{assert.equal(blockedOpenAIStream.status,200);assert.equal(blockedOpenAIStreamText.includes('event: error'),false);assert.ok(blockedOpenAIStreamText.includes('"stop_reason":"refusal"'));assert.ok(blockedOpenAIStreamText.includes('"category":"cyber"'));assert.ok(blockedOpenAIStreamText.includes('flagged for possible cybersecurity risk'));assert.ok(blockedOpenAIStreamText.includes('event: message_stop'));});
    const blockedOpenAINonstream=await send({model:'claude-gpt-6-astra[1m]',stream:false});
    const blockedOpenAINonstreamBody=await blockedOpenAINonstream.json();
    check('OpenAI nonstream cybersecurity rejections preserve refusal details',()=>{assert.equal(blockedOpenAINonstream.status,200);assert.equal(blockedOpenAINonstreamBody.stop_reason,'refusal');assert.equal(blockedOpenAINonstreamBody.stop_details.category,'cyber');assert.ok(blockedOpenAINonstreamBody.stop_details.explanation.includes('flagged for possible cybersecurity risk'));});
    openAIStreamMode='invalid-prompt-failed';
    const invalidOpenAINonstream=await send({model:'claude-gpt-6-astra[1m]',stream:false});
    const invalidOpenAINonstreamBody=await invalidOpenAINonstream.json();
    check('Other invalid prompts remain permanent API errors',()=>{assert.equal(invalidOpenAINonstream.status,400);assert.equal(invalidOpenAINonstreamBody.error.type,'invalid_request_error');assert.ok(invalidOpenAINonstreamBody.error.message.includes('Fixture prompt is invalid'));});
    openAIStreamMode='truncated';
    const truncatedOpenAINonstream=await send({model:'claude-gpt-5.6-sol[1m]',stream:false});
    const truncatedOpenAINonstreamBody=await truncatedOpenAINonstream.json();
    check('OpenAI nonstream truncation returns a retryable status instead of empty HTTP 200',()=>{assert.equal(truncatedOpenAINonstream.status,502);assert.ok(truncatedOpenAINonstreamBody.error.message.includes('terminal response'));});
    openAIStreamMode='complete';
    const openaiInvalidBefore=calls.length;
    const openaiInvalid=await send({model:'claude-gpt-5.4[1m]',stream:true,output_config:{effort:'max'}});
    check('unsupported OpenAI effort is refused instead of remapped',()=>{assert.equal(openaiInvalid.status,400);assert.equal(calls.length,openaiInvalidBefore);});
    const stubModelId='claude-Stub-Compat-agent[1m]';
    const stub=await send({model:stubModelId,stream:true,system:[{type:'text',text:'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.'},{type:'text',text:'Keep this instruction.'}],thinking:{type:'adaptive'},output_config:{effort:'high'}});
    const stubText=await stub.text();
    check('a compatible provider relays native Anthropic streaming and preserves the client alias',()=>{const call=calls.at(-1);assert.equal(stub.status,200);assert.ok(stubText.includes('MOCK_COMPAT 🐉'));assert.ok(stubText.includes(stubModelId));assert.equal(call.path,'/stub/messages');assert.equal(call.body.model,'Stub-Compat-agent');assert.deepEqual(call.body.system,[{type:'text',text:'Keep this instruction.'}]);assert.equal(call.body.thinking,undefined);assert.equal(call.body.output_config,undefined);assert.equal(call.headers['x-api-key'],'stub-test-key-one');assert.equal(stub.headers.get('x-cuimod-prompt-policy-id'),'preserve');});
    const stubCountBefore=calls.length;
    const stubCount=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:stubModelId,system:'count this system',messages:[{role:'user',content:'count this message'}]})});
    const stubCountBody=await stubCount.json();
    check('a compatible provider uses its native complete-prompt counter',()=>{assert.equal(stubCount.status,200);assert.equal(stubCountBody.input_tokens,321);assert.equal(calls.length,stubCountBefore+1);assert.equal(calls.at(-1).path,'/stub/messages/count_tokens');assert.equal(stubCount.headers.get('x-cuimod-token-count-source'),'stub.messages.count_tokens');assert.equal(stubCount.headers.get('x-cuimod-token-count-exact'),'true');});
    failStubCount=true;
    const failingStubCountBody={model:stubModelId,messages:[{role:'user',content:'uncached compat count failure'}]};
    const failedStubCount=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(failingStubCountBody)});
    await failedStubCount.text();
    failStubCount=false;
    const stubCountCalls=calls.length;
    const recoveredStubCount=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(failingStubCountBody)});
    check('compatible native count errors are not cached',()=>{assert.equal(failedStubCount.status,429);assert.equal(recoveredStubCount.status,200);assert.equal(calls.length,stubCountCalls+1);});
    fs.writeFileSync(catalogueFile,JSON.stringify([stubModel(base+'/stub-next')]));
    fs.writeFileSync(secretsFile,JSON.stringify({stub:{apiKey:'stub-test-key-two'}}));
    await (await send({model:stubModelId,stream:false})).text();
    check('compatible provider catalogue and credentials hot reload per request',()=>{assert.equal(calls.at(-1).path,'/stub-next/messages');assert.equal(calls.at(-1).headers['x-api-key'],'stub-test-key-two');});
    fs.writeFileSync(catalogueFile,'{broken');
    await (await send({model:stubModelId,stream:false})).text();
    check('a malformed catalogue keeps the last-good compatible backend',()=>assert.equal(calls.at(-1).path,'/stub-next/messages'));
    fs.writeFileSync(secretsFile,'{broken');
    await (await send({model:stubModelId,stream:false})).text();
    check('a malformed credential edit keeps the last-good compatible key',()=>assert.equal(calls.at(-1).headers['x-api-key'],'stub-test-key-two'));
    fs.writeFileSync(secretsFile,JSON.stringify({stub:{apiKey:'stub-test-key-two'}}));
    failStub=true;const stubLimitedBefore=calls.length;const stubLimited=await send({model:stubModelId,stream:true});const stubLimitedBody=await stubLimited.json();
    check('compatible quota errors preserve retry timing and stay on the provider',()=>{assert.equal(stubLimited.status,429);assert.equal(stubLimited.headers.get('retry-after'),'29');assert.equal(stubLimitedBody.error.message,'Stub quota exhausted');assert.equal(calls.length,stubLimitedBefore+1);assert.equal(calls.at(-1).path,'/stub-next/messages');});
    failStub=false;
    // Qwen was removed from the shipped catalogue, so every Qwen alias now
    // takes the fail-closed arm. It must stay 503 rather than fall through to
    // Anthropic, which would answer a Qwen-labelled request as Claude.
    const retiredBefore=calls.length;const retired=await send({model:'claude-Qwen3.8-Max-agent[1m]',stream:false});
    check('retired Qwen aliases fail closed instead of reaching Anthropic',()=>{assert.equal(retired.status,503);assert.equal(calls.length,retiredBefore);});
    fs.writeFileSync(catalogueFile,JSON.stringify([{...stubModel(base+'/stub-next'),id:'Stub-Alias-agent',upstreamId:'accounts/stub/models/compat-1'}]));
    const aliased=await send({model:'claude-Stub-Alias-agent[1m]',stream:false});const aliasedText=await aliased.text();
    check('a compatible alias sends the provider its own upstream model name',()=>{assert.equal(aliased.status,200);assert.equal(calls.at(-1).body.model,'accounts/stub/models/compat-1');assert.ok(aliasedText.includes('claude-Stub-Alias-agent[1m]'));});
    // A provider with no count_tokens endpoint gets an exact local count of the
    // body it would be sent. 32 is Fireworks' own raw_output id count for this
    // request (tests/fixtures/deepseek-v41-fireworks.json, case "plain").
    fs.writeFileSync(catalogueFile,JSON.stringify([{...stubModel(base+'/stub-next'),id:'Stub-Counted-agent',counter:'deepseek-v4.1-fireworks'}]));
    const countedBefore=calls.length;
    const counted=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-Stub-Counted-agent[1m]',system:'sys',messages:[{role:'user',content:'hi'}]})});
    const countedBody=await counted.json();
    check('a compatible provider with a local counter counts exactly without calling upstream',()=>{assert.equal(counted.status,200);assert.equal(countedBody.input_tokens,32);assert.equal(calls.length,countedBefore);assert.equal(counted.headers.get('x-cuimod-token-count-source'),'deepseek-v4.1-fireworks.local');assert.equal(counted.headers.get('x-cuimod-token-count-exact'),'true');});
    const rejected=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-Stub-Counted-agent[1m]',system:'sys',messages:[{role:'user',content:[{type:'document',source:{type:'text',media_type:'text/plain',data:'x'}}]}]})});
    check('a block the provider rejects fails the local count with a 400',()=>{assert.equal(rejected.status,400);assert.equal(calls.length,countedBefore);});
    // The picker's tier rides in the model id; the native slider sends
    // output_config.effort; neither present means the catalogue default.
    fs.writeFileSync(catalogueFile,JSON.stringify([{...stubModel(base+'/stub-next'),id:'Stub-Effort-agent',efforts:['low','high','max'],defaultEffort:'high',effortField:'reasoning_effort',effortValues:{none:'none',low:50,medium:75,high:75,xhigh:100,max:100}}]));
    const effortOf=async(model,extra={})=>{await (await send({model,stream:false,...extra})).text();return calls.at(-1).body;};
    const viaSuffix=await effortOf('claude-Stub-Effort-agent:none[1m]',{output_config:{effort:'max'}});
    const viaSlider=await effortOf('claude-Stub-Effort-agent[1m]',{output_config:{effort:'low'}});
    const viaChild=await effortOf('claude-Stub-Effort-agent[1m]',{output_config:{effort:'medium'}});
    const viaDefault=await effortOf('claude-Stub-Effort-agent[1m]');
    check('a compatible effort tier reaches the provider field from suffix, slider, or default',()=>{assert.equal(viaSuffix.reasoning_effort,'none');assert.equal(viaSlider.reasoning_effort,50);assert.equal(viaChild.reasoning_effort,75);assert.equal(viaDefault.reasoning_effort,75);assert.equal(viaSlider.output_config,undefined);assert.equal(viaSuffix.model,'Stub-Effort-agent');});
    fs.writeFileSync(catalogueFile,JSON.stringify([stubModel(base+'/stub-next')]));
    const listed=await (await fetch(endpoint+'/v1/models',{headers:{authorization:'Bearer fixture'}})).json();
    check('a compatible provider appears in the router model catalogue',()=>assert.ok(listed.data.some(entry=>entry.id==='Stub-Compat-agent')));
    splitFraming=true;
    const split=await send({model:stubModelId,stream:true});const splitText=await split.text();
    splitFraming=false;
    check('a native Anthropic stream survives CRLF framing split mid-UTF-8',()=>{assert.equal(split.status,200);assert.ok(splitText.includes('MOCK_COMPAT \u{1F409}'));assert.ok(splitText.includes(stubModelId));assert.ok(splitText.includes('message_stop'));});
    const policyBody={model:'claude-opus-5',system:'original system',messages:[{role:'user',content:'test'}],tools:[{name:'read_file',description:'Read files',input_schema:{type:'object',properties:{}}}],stream:false};
    const policy={id:'live-policy',name:'Live policy',generation:1,enabled:true,systemMode:'replace',systemText:'replacement system',userPrefix:'before user',userSuffix:'after user',toolDescriptionPrefix:'before tool: ',toolDescriptionSuffix:' :after tool'};
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{activePromptPolicyId:'live-policy',promptPolicies:[policy]}}));
    const modified=await send(policyBody,'anthropic-policy-session');await modified.text();
    check('Claude Messages receives the same live prompt policy as alternate providers',()=>{const call=calls.at(-1);assert.equal(modified.status,200);assert.equal(modified.headers.get('x-cuimod-prompt-policy-id'),'live-policy');assert.equal(call.body.system,'replacement system');assert.deepEqual(call.body.messages[0].content,[{type:'text',text:'before user'},{type:'text',text:'test'},{type:'text',text:'after user'}]);assert.equal(call.body.tools[0].description,'before tool: Read files :after tool');});
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{activePromptPolicyId:'live-policy',promptPolicies:[{...policy,generation:2,systemText:'next-request system'}]}}));
    const revised=await send(policyBody,'anthropic-policy-session');await revised.text();
    check('policy generation changes affect the next request in an existing conversation',()=>{const capture=JSON.parse(fs.readFileSync(path.join(temp,'prompt-policy-capture-v2.json'),'utf8')).entries.find(entry=>entry.provider==='anthropic'&&entry.sessionId==='anthropic-policy-session');assert.equal(revised.headers.get('x-cuimod-prompt-policy-generation'),'2');assert.equal(calls.at(-1).body.system,'next-request system');assert.equal(capture.system,'original system');assert.equal(capture.effectiveSystem,'next-request system');});
    const controlRaw='{ "model": "claude-sonnet-5", "system": "You are a security monitor for autonomous AI coding agents.", "messages": [{"role":"user","content":"classify"}], "tools": [] }';
    const controlSid='alternate-control-session';
    const mainSystem='x-anthropic-billing-header: cc_version=2.1.260; cc_entrypoint=claude-desktop;';
    await (await send({model:'claude-gpt-5.6-sol[1m]',system:mainSystem,tools:[{name:'read_file',input_schema:{type:'object'}}],stream:false},controlSid)).text();
    const inherited=await send(controlRaw,controlSid);const inheritedBody=await inherited.json();
    check('auto-mode control requests inherit the main agent alternate route and default to JSON',()=>{const call=calls.at(-1);assert.equal(inherited.status,200);assert.equal(inherited.headers.get('content-type'),'application/json');assert.equal(inheritedBody.usage.input_tokens,10);assert.equal(call.path,'/responses');assert.equal(call.body.model,'gpt-5.6-sol');});
    await (await send({model:stubModelId,system:'x-anthropic-billing-header: cc_is_subagent=true',tools:[{name:'read_file',input_schema:{type:'object'}}],stream:false},controlSid)).text();
    const afterSubagent=await send(controlRaw,controlSid);await afterSubagent.json();
    check('a subagent sharing the session id cannot replace the root control route',()=>{assert.equal(calls.at(-1).path,'/responses');assert.equal(calls.at(-1).body.model,'gpt-5.6-sol');});
    await (await send({model:'claude-opus-5',system:mainSystem,tools:[{name:'read_file',input_schema:{type:'object'}}],stream:false},controlSid)).text();
    const afterNativeSwitch=await send(controlRaw,controlSid);await afterNativeSwitch.text();
    check('switching the main agent back to Claude clears control-route inheritance',()=>{assert.equal(calls.at(-1).path,'/anthropic/v1/messages');assert.equal(calls.at(-1).raw,controlRaw);});
    const control=await send(controlRaw,'anthropic-policy-session');await control.text();
    check('control-plane requests bypass policies and cannot replace the agent capture',()=>{const capture=JSON.parse(fs.readFileSync(path.join(temp,'prompt-policy-capture-v2.json'),'utf8')).entries.find(entry=>entry.provider==='anthropic'&&entry.sessionId==='anthropic-policy-session');assert.equal(control.headers.get('x-cuimod-prompt-policy-id'),'preserve');assert.equal(calls.at(-1).raw,controlRaw);assert.equal(capture.system,'original system');assert.equal(capture.effectiveSystem,'next-request system');});
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{activePromptPolicyId:'preserve',promptPolicies:[policy]}}));
    const raw='{ "model": "claude-opus-5", "messages": [{"role":"user","content":"test"}], "stream": false }';
    const claude=await send(raw);
    check('Claude Preserve remains byte-identical while still exposing policy identity',()=>{assert.equal(calls.at(-1).raw,raw);assert.ok(calls.at(-1).path.startsWith('/anthropic'));assert.equal(claude.status,200);assert.equal(claude.headers.get('x-cuimod-prompt-policy-id'),'preserve');});
    await claude.text();
    failClaude=true;
    for(const route of ['/v1/messages','/v1/messages/count_tokens']) {
        const previous=calls.length;
        const response=await fetch(endpoint+route,{method:'POST',headers:{'content-type':'application/json'},body:raw});
        const body=await response.json();
        check('Claude quota errors never switch provider on '+route,()=>{assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'19');assert.equal(body.error.message,'Claude quota exhausted');assert.equal(calls.length,previous+1);assert.equal(calls.at(-1).raw,raw);assert.equal(calls.at(-1).path,'/anthropic'+route);});
    }
    failOpenAI=true;
    const previous=calls.length;
    const limited=await send({model:'claude-gpt-5.6-sol[1m]',stream:true});
    const limitedBody=await limited.json();
    check('OpenAI quota errors preserve retry timing without switching provider',()=>{assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'23');assert.equal(limitedBody.error.type,'rate_limit_error');assert.equal(calls.length,previous+1);assert.equal(calls.at(-1).path,'/responses');});
    {
        const model='claude-gpt-5.6-sol[1m]';
        const previous=calls.length;
        const counted=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'A small context fixture'}]})});
        const result=await counted.json();
        check(model+' counts without triggering inference',()=>{
            assert.equal(counted.status,200);assert.ok(result.input_tokens>0);
            assert.equal(calls.length,previous);
            assert.equal(counted.headers.get('x-cuimod-token-count-source'),'o200k_base-estimate');
        });
    }
    let wrote=false,destroyed=false;
    server.emit('clientError',{code:'ECONNRESET'},{writable:true,destroyed:false,end(){wrote=true;},destroy(){destroyed=true;}});
    check('reset connections are destroyed without writing another socket error',()=>{assert.equal(destroyed,true);assert.equal(wrote,false);});
    const rates=await(await fetch(endpoint+'/throughputz')).json();
    const byProvider=Object.fromEntries(rates.providers.map(row=>[row.key,row]));
    check('every streaming arm records a generation rate, including the compatible one',()=>{
        // The compatible arm is the regression this covers: the compatible arm passed no usage
        // observer at all, so it produced neither an exact token record nor a rate.
        // The Anthropic passthrough fixture answers with a body carrying no id and
        // no usage, so it correctly records nothing here; its observer path is the
        // one exercised in provider-throughput.test.mjs.
        for(const provider of ['openai','stub']) assert.ok(byProvider[provider],'no throughput record for '+provider);
        assert.equal(byProvider.claude,undefined,'a response with no usage must not produce an invented rate');
        assert.ok(byProvider.stub.outputTokens>0);
        assert.equal(rates.live.length,0,'nothing is still streaming once every response has been read');
        assert.equal(JSON.stringify(rates).includes('stub-test-key'),false,'a rate payload must never carry a credential');
        assert.equal(JSON.stringify(rates).includes(token),false);
    });
    const history=await(await fetch(endpoint+'/throughput/api?session=573cf3ba-87d3-4bd2-8f56-ea1b4446f72d')).json();
    check('throughput history filters by session and keeps no response content',()=>{
        assert.ok(history.matched>0);
        assert.ok(history.records.every(record=>record.sessionId==='573cf3ba-87d3-4bd2-8f56-ea1b4446f72d'));
        assert.ok(history.records.every(record=>record.responseId&&record.tokens&&!('content' in record)));
        assert.ok(history.lanes.length>0);
    });
    const empty=await(await fetch(endpoint+'/throughput/api?session=no-such-session')).json();
    check('an unknown session returns an empty history rather than everything',()=>{assert.equal(empty.matched,0);assert.equal(empty.records.length,0);});
    const health=await(await fetch(endpoint+'/healthz')).json();
    check('healthz names the throughput ledger',()=>{assert.ok(health.throughput.file.endsWith('provider-throughput-v1.jsonl'));assert.equal(health.throughput.api,'/throughputz');assert.ok(health.throughput.records>0);});
    check('healthz exposes sanitized model route ownership',()=>{
        for(const id of ['gpt-6-sol','gpt-6-luna']) {
            const route=health.modelRoutes.find(value=>value.id===id);
            assert.equal(route.provider,'openai');
            assert.equal(route.context,1050000);
        }
        assert.ok(health.modelRoutes.every(route=>!('credential' in route)&&!('token' in route)));
    });
    console.log(passed+' real-router checks passed; no external requests');
} finally {
    server.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);
    fs.rmSync(temp, { recursive: true, force: true });
}
