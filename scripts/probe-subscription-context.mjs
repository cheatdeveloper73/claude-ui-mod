// Explicit opt-in: one large synthetic-input call to the user's subscription.
// No tools, no private documents, and no Claude Desktop session is touched.
import { chatgptAuth, responsesHeaders, RESPONSES_URL, sseParser } from '../router/openai.mjs';
const live = process.argv.includes('--live');
const model = 'gpt-5.5';
const repetitions = 900000;
if (!live) {
    console.log('Prepared GPT-5.5 subscription test: approximately 900,000 input tokens, synthetic filler only, low reasoning, requested reply OK.');
    console.log('No request sent. Add --live only after approving the subscription usage.');
} else {
    const body = { model, instructions: 'Return exactly OK. The repeated filler is intentionally irrelevant; do not analyze it.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Filler:' + ' a'.repeat(repetitions) + '\nEnd filler. Return OK.' }] }],
        reasoning: { effort: 'low', summary: 'auto' }, stream: true, store: false,
    };
    const tokens = await chatgptAuth(() => {});
    const response = await fetch(RESPONSES_URL, { method: 'POST', headers: responsesHeaders(tokens, 'subscription-context-probe'), body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    if (!response.ok) {
        console.log(JSON.stringify({model,status:response.status,error:(await response.text()).slice(0,4000)},null,2));
        process.exitCode=1;
    } else {
        let usage, output='', error;
        const feed=sseParser(event=>{
            if(event.type==='response.output_text.delta')output+=event.delta||'';
            if(event.type==='response.completed')usage=event.response?.usage;
            if(event.type==='response.failed'||event.type==='error')error=event;
        });
        const decoder=new TextDecoder();
        for await(const chunk of response.body)feed(decoder.decode(chunk,{stream:true}));
        console.log(JSON.stringify({model,status:response.status,usage,output:output.slice(0,200),error},null,2));
    }
}
