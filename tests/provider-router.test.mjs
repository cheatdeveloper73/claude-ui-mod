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
        if(req.url === '/responses') {
            if(failOpenAI) {res.writeHead(429,{'content-type':'application/json','retry-after':'23'});res.end('{"error":{"message":"OpenAI quota exhausted"}}');return;}
            res.setHeader('content-type','text/event-stream');
            const created={type:'response.created',response:{id:'resp_fixture',model:'reported-model-fixture',reasoning:{effort:'low'},usage:{input_tokens:10,output_tokens:0}}};
            const compacting=body.input?.at(-1)?.type==='compaction_trigger';
            const renderingFallback=body.input?.some(item=>item?.type==='compaction')&&body.input?.at(-1)?.type==='message';
            const compactItem={type:'compaction',id:'cmp_fixture',encrypted_content:'encrypted-checkpoint-fixture'};
            const complete=compacting
                ? [created,{type:'response.output_item.added',output_index:0,item:compactItem},{type:'response.output_item.done',output_index:0,item:compactItem},{type:'response.completed',response:{id:'resp_compact_fixture',model:body.model,usage:{input_tokens:100,output_tokens:12}}}]
                : [created,{type:'response.output_item.added',output_index:0,item:{type:'message'}},{type:'response.output_text.delta',output_index:0,delta:renderingFallback?'Portable checkpoint summary with PROJECT-729.':'MOCK_OPENAI'},{type:'response.output_item.done',output_index:0,item:{type:'message'}},{type:'response.completed',response:{id:renderingFallback?'resp_fallback_fixture':'resp_fixture',model:'reported-model-fixture',reasoning:{effort:'low'},usage:{input_tokens:10,output_tokens:2}}}];
            const events=openAIStreamMode==='failed'?[created,{type:'response.failed',response:{error:{message:'fixture stream failure'}}}]:openAIStreamMode==='truncated'?[created]:complete;
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
Object.assign(process.env,{CODEX_AUTH_FILE:auth,CODEX_RESPONSES_URL:base+'/responses',MODEL_ROUTER_UPSTREAM:base+'/anthropic',MODEL_ROUTER_ADAPTER_DIR:adapterDir,MODEL_ROUTER_STATE_DIR:temp,MODEL_ROUTER_SETTINGS_FILE:path.join(temp,'settings.json'),MODEL_ROUTER_CATALOGUE_FILE:catalogueFile,MODEL_ROUTER_SECRETS_FILE:secretsFile});
const {server}=await import(pathToFileURL(path.join(root,'index.mjs')));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint='http://127.0.0.1:'+server.address().port;
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
async function send(body, sid='573cf3ba-87d3-4bd2-8f56-ea1b4446f72d') {
    return fetch(endpoint+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':sid},body:typeof body==='string'?body:JSON.stringify({max_tokens:2000,messages:[{role:'user',content:'test'}],...body})});
}
try {
    for(const [slug,effort] of [['gpt-5.6-sol','max'],['gpt-5.6-luna','xhigh'],['gpt-5.5','high']]) {
        const model='claude-'+slug+'[1m]';
        const res=await send({model,stream:true,output_config:{effort}});const text=await res.text();const call=calls.at(-1);
        check(slug+' native effort reaches Responses',()=>{assert.equal(call.body.model,slug);assert.equal(call.body.reasoning.effort,effort);assert.equal(res.status,200);assert.equal(res.headers.get('x-cuimod-prompt-policy-id'),'preserve');assert.equal(res.headers.get('x-cuimod-prompt-policy-generation'),'1');assert.ok(text.includes(model));assert.ok(text.includes('MOCK_OPENAI'));assert.ok(text.includes('message_stop'));assert.equal(call.body.max_output_tokens,undefined);});
    }
    check('identity diagnostics use upstream metadata, not the requested label',()=>{const log=fs.readFileSync(path.join(temp,'bridge.log'),'utf8');assert.ok(log.includes('"reportedModel":"reported-model-fixture"'));assert.ok(log.includes('"requestedModel":"gpt-5.6-sol"'));assert.ok(log.includes('"reportedEffort":"low"'));assert.equal(log.includes(token),false);});
    const settingsFile=process.env.MODEL_ROUTER_SETTINGS_FILE;
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'detailed',logUpstreamIdentity:false}}));
    const logBefore=fs.readFileSync(path.join(temp,'bridge.log'),'utf8').split('openai-response-identity').length;
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,output_config:{effort:'high'}})).text();
    check('dashboard changes affect the next request without restarting',()=>{assert.equal(calls.at(-1).body.reasoning.summary,'detailed');assert.equal(calls.at(-1).body.reasoning.effort,'high');assert.equal(fs.readFileSync(path.join(temp,'bridge.log'),'utf8').split('openai-response-identity').length,logBefore);});
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'off'}}));
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true})).text();
    check('summary off preserves encrypted reasoning replay',()=>{assert.equal(calls.at(-1).body.reasoning.summary,undefined);assert.deepEqual(calls.at(-1).body.include,['reasoning.encrypted_content']);});

    const compactPrompt='Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.\n\nPreserve everything important.';
    const compactSid='compact-session-fixture';
    fs.writeFileSync(settingsFile,JSON.stringify({'provider-picker':{reasoningSummary:'auto'},'compaction-provider':{strategy:'codex',portableFallback:true,model:'current'}}));
    const compactCallsBefore=calls.length;
    const compactResponse=await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:'The project marker is PROJECT-729.'},{role:'assistant',content:[{type:'text',text:'Working on it.'}]},{role:'user',content:compactPrompt}]},compactSid);
    const compactText=await compactResponse.text();
    const marker=/\[\[cuimod:codex-compact:v1:([A-Za-z0-9_-]{24})\]\]/.exec(compactText);
    check('GPT compaction uses Codex V2 and returns a durable Claude summary',()=>{
        assert.equal(compactResponse.status,200);assert.equal(compactResponse.headers.get('x-cuimod-compaction'),'codex-v2');assert.ok(marker);assert.ok(compactText.includes('Portable checkpoint summary with PROJECT-729.'));
        const compactCall=calls[compactCallsBefore];const fallbackCall=calls[compactCallsBefore+1];
        assert.equal(calls.length,compactCallsBefore+2);assert.equal(compactCall.body.input.at(-1).type,'compaction_trigger');assert.equal(compactCall.body.input.some(item=>JSON.stringify(item).includes('detailed summary of the conversation')),false);assert.equal(fallbackCall.body.input[0].type,'compaction');
        assert.ok(fs.existsSync(path.join(temp,'compactions-v1',marker[1]+'.json')));
    });
    const wrappedSummary='This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n'+marker[0]+'\n\nPortable checkpoint summary with PROJECT-729.';
    const restoreCallsBefore=calls.length;
    await (await send({model:'claude-gpt-5.6-sol[1m]',stream:true,messages:[{role:'user',content:wrappedSummary},{role:'user',content:'Continue the work.'}]},compactSid)).text();
    check('the next GPT turn restores opaque state instead of sending summary prose',()=>{
        assert.equal(calls.length,restoreCallsBefore+1);const input=calls.at(-1).body.input;assert.ok(input.some(item=>item.type==='compaction'&&item.encrypted_content==='encrypted-checkpoint-fixture'));assert.equal(JSON.stringify(input).includes('cuimod:codex-compact'),false);assert.equal(JSON.stringify(input).includes('Portable checkpoint summary'),false);
    });
    const countCallsBefore=calls.length;
    const restoredCount=await fetch(endpoint+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':compactSid},body:JSON.stringify({model:'claude-gpt-5.6-sol[1m]',messages:[{role:'user',content:wrappedSummary},{role:'user',content:'Count restored state.'}]})});
    check('token counting resolves the same checkpoint without inference',()=>{assert.equal(restoredCount.status,200);assert.equal(calls.length,countCallsBefore);});
    const claudePortable=await send({model:'claude-opus-5',stream:false,messages:[{role:'user',content:wrappedSummary},{role:'user',content:'Continue portably.'}]},compactSid);await claudePortable.text();
    check('non-OpenAI providers receive the fallback without the private marker',()=>{const sent=JSON.stringify(calls.at(-1).body);assert.ok(sent.includes('Portable checkpoint summary with PROJECT-729.'));assert.equal(sent.includes('cuimod:codex-compact'),false);});
    const status=await(await fetch(endpoint+'/compactionz?session='+compactSid)).json();
    check('compaction status exposes metadata without encrypted content',()=>{assert.equal(status.checkpoints.count,1);assert.equal(status.checkpoints.latest.sourceModel,'gpt-5.6-sol');assert.equal(JSON.stringify(status).includes('encrypted-checkpoint-fixture'),false);});
    fs.writeFileSync(settingsFile,JSON.stringify({'compaction-provider':{strategy:'native',portableFallback:true,model:'current'}}));
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
    const controlRaw='{ "model": "claude-sonnet-5", "system": "You are a security monitor for autonomous AI coding agents.", "messages": [{"role":"user","content":"classify"}], "tools": [], "stream": false }';
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
    console.log(passed+' real-router checks passed; no external requests');
} finally {
    server.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);
    fs.rmSync(temp, { recursive: true, force: true });
}
