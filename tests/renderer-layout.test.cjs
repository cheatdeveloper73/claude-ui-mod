'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = process.env.CUIMOD_LAYOUT_SOURCE_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/runtime/bridge.js'), 'utf8');

function fixture() {
    let serial = 0;
    const frames = new Map(), timers = new Map(), intervals = new Map();
    const observers = [], resizers = [], listeners = new Map();
    const counts = { queries: 0, rects: 0 };
    const selection = new Map();
    class Node {
        constructor(name, rect, parent = null) {
            this.name = name; this.nodeType = 1; this.parentElement = parent;
            this.isConnected = true; this.id = ''; this.rect = rect;
            this.attributes = new Map(); this.children = [];
            if (parent) parent.children.push(this);
        }
        matches(selector) { return selector === '[data-testid="epitaxy-virtual-transcript"]' && this.name === 'transcript'; }
        closest(selector) {
            for (let p = this; p; p = p.parentElement) {
                if (p.matches(selector) || (selector === '.epitaxy-composer-width' && p.composerWidth) || (selector === '[id^="cuimod-"]' && p.id.startsWith('cuimod-')) ||
                    (selector === '#cuimod-queue' && p.id === 'cuimod-queue')) return p;
            }
            return null;
        }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        getBoundingClientRect() { counts.rects++; return this.rect; }
        querySelectorAll(selector) { counts.queries++; return selection.get(this.name + ':' + selector) || []; }
    }
    function events(name, target = {}) {
        target.addEventListener = (type, fn) => {
            const key = name + ':' + type;
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key).add(fn);
        };
        target.removeEventListener = (type, fn) => listeners.get(name + ':' + type)?.delete(fn);
        return target;
    }
    const html = new Node('html', {left:0,top:0,right:1600,bottom:1000,width:1600,height:1000});
    const document = events('document', {documentElement:html,hidden:false,querySelectorAll(selector){counts.queries++;return selection.get(selector)||[];}});
    const window = events('window');
    const ctx = {
        document, window, location:{pathname:'/epitaxy/new',search:''}, innerWidth:1600, innerHeight:1000,
        MutationObserver: class {
            constructor(fn) { this.fn=fn; this.active=true; observers.push(this); }
            observe() {} disconnect() { this.active=false; }
        },
        ResizeObserver: class {
            constructor(fn) { this.fn=fn; this.nodes=new Set(); this.active=true; resizers.push(this); }
            observe(node) { this.nodes.add(node); } unobserve(node) { this.nodes.delete(node); }
            disconnect() { this.active=false; this.nodes.clear(); }
        },
        requestAnimationFrame(fn){const id=++serial;frames.set(id,fn);return id;}, cancelAnimationFrame(id){frames.delete(id);},
        setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;}, clearTimeout(id){timers.delete(id);},
        setInterval(fn,ms){const id=++serial;intervals.set(id,{fn,ms});return id;}, clearInterval(id){intervals.delete(id);},
        getComputedStyle:()=>({borderTopLeftRadius:'12px'}),queueMicrotask,
    };
    const boot = {rpc:async()=>null,observeInvoke:()=>()=>{},appOn:()=>()=>{},eipc:()=>'',log:()=>{}};
    ctx.boot=boot;
    ctx.plugins=[{name:'fixture',source:'globalThis.fixtureCtx = ctx; globalThis.fixtureErrors = cuimod.errors;'}];
    const runtime=vm.runInNewContext('(function(boot,plugins){'+source+'\n})(boot,plugins)',ctx);
    const api=ctx.fixtureCtx;
    const frame=()=>{const ready=[...frames.values()];frames.clear();ready.forEach(fn=>fn());};
    const mutate=record=>observers.filter(o=>o.active).forEach(o=>o.fn([record]));
    const event=(target,type,value={})=>{for(const fn of listeners.get(target+':'+type)||[])fn(value);};
    return {Node,html,document,window,api,runtime,ctx,counts,selection,frames,timers,intervals,observers,resizers,frame,mutate,event,
        reset(){counts.queries=counts.rects=0;},
        node(name,rect,parent=html){return new Node(name,rect,parent);}};
}
const rect=(left=600,width=768,top=800,height=100)=>({left,width,top,height,right:left+width,bottom:top+height});

test('opt-in layout coalesces clients and reads every client before any writes',()=>{
    const h=fixture(), anchor=h.node('anchor',rect());h.selection.set('.anchor',[anchor]);
    const order=[];
    const a=h.api.layout(l=>{order.push('a-read');return l.rect(l.query('.anchor'));},()=>order.push('a-write'));
    h.api.layout(l=>{order.push('b-read');return l.rect(l.query('.anchor'));},()=>order.push('b-write'));
    a();a();a();assert.equal(h.frames.size,1);h.frame();
    assert.deepEqual(order,['a-read','b-read','a-write','b-write']);
    assert.deepEqual(h.counts,{queries:1,rects:1});
    h.reset();a();h.frame();assert.deepEqual(h.counts,{queries:0,rects:0});
    assert.equal(h.resizers[0].nodes.has(anchor),true);
    h.runtime.dispose();
});

test('contained transcript mutations and scrolling do not invalidate shell geometry',()=>{
    const h=fixture(),anchor=h.node('anchor',rect()),feed=h.node('transcript',rect()),text=h.node('text',rect(),feed);
    h.selection.set('.anchor',[anchor]);let calls=0;
    h.api.layout(l=>l.rect(l.query('.anchor')),()=>calls++);h.frame();h.reset();
    for(let i=0;i<100;i++){
        h.mutate({type:'childList',target:feed,addedNodes:[text],removedNodes:[]});
        h.mutate({type:'attributes',target:text,attributeName:'style',oldValue:null});
        h.event('window','scroll',{target:feed});
    }
    assert.equal(h.frames.size,0);assert.equal(calls,1);assert.deepEqual(h.counts,{queries:0,rects:0});
    feed.attributes.set('style','height:400px');
    h.mutate({type:'attributes',target:feed,attributeName:'style',oldValue:null});
    assert.equal(h.frames.size,1);h.frame();assert.equal(calls,2);
    h.runtime.dispose();
});

test('shell replacement invalidates discovery even when the obsolete composer stays connected',()=>{
    const h=fixture(),old=h.node('old',rect()),replacement=h.node('replacement',rect(650,700));
    h.selection.set('.epitaxy-prompt',[old]);let selected;
    h.api.layout(l=>l.mainComposer(),value=>selected=value);h.frame();assert.equal(selected,old);
    old.rect=rect(0,0,0,0);h.selection.set('.epitaxy-prompt',[old,replacement]);
    h.mutate({type:'childList',target:h.html,addedNodes:[replacement],removedNodes:[]});h.frame();
    assert.equal(old.isConnected,true);assert.equal(selected,replacement);
    h.runtime.dispose();
});

test('hidden preferred-width composers cannot win over the visible replacement',()=>{
    const h=fixture(),old=h.node('old',rect(0,0,0,0)),replacement=h.node('replacement',rect(650,700));
    old.composerWidth=true;
    h.selection.set('.epitaxy-prompt',[old,replacement]);let selected;
    h.api.layout(l=>l.mainComposer(),value=>selected=value);h.frame();
    assert.equal(old.isConnected,true);assert.equal(selected,replacement);
    h.runtime.dispose();
});

test('ResizeObserver remeasures cached nodes without rescanning discovery',()=>{
    const h=fixture(),anchor=h.node('anchor',rect());h.selection.set('.anchor',[anchor]);let left;
    h.api.layout(l=>l.rect(l.query('.anchor')).left,value=>left=value);h.frame();h.reset();
    anchor.rect=rect(740);h.resizers[0].fn();h.frame();
    assert.equal(left,740);assert.deepEqual(h.counts,{queries:0,rects:1});
    h.runtime.dispose();
});

test('hidden visibility transfers an already queued frame to the timeout path',()=>{
    const h=fixture(),anchor=h.node('anchor',rect());h.selection.set('.anchor',[anchor]);let calls=0;
    h.api.layout(l=>l.rect(l.query('.anchor')),()=>calls++);assert.equal(h.frames.size,1);
    h.document.hidden=true;h.event('document','visibilitychange');assert.equal(h.frames.size,0);
    const work=[...h.timers].filter(([,timer])=>timer.ms===0);
    assert.equal(work.length,1);for(const [id,timer]of work){h.timers.delete(id);timer.fn();}
    assert.equal(calls,1);
    h.document.hidden=false;h.event('document','visibilitychange');h.frame();assert.equal(calls,2);
    h.runtime.dispose();
});

test('late queue mounts and actual position changes invalidate while identical style writes do not',()=>{
    const h=fixture();let queue;
    h.api.layout(l=>l.query('#cuimod-queue'),value=>queue=value);h.frame();assert.equal(queue,null);
    const mounted=h.node('queue',rect());mounted.id='cuimod-queue';h.selection.set('#cuimod-queue',[mounted]);
    h.mutate({type:'childList',target:h.html,addedNodes:[mounted],removedNodes:[]});h.frame();assert.equal(queue,mounted);
    mounted.attributes.set('style','left:600px');
    h.mutate({type:'attributes',target:mounted,attributeName:'style',oldValue:'left:600px'});assert.equal(h.frames.size,0);
    h.mutate({type:'attributes',target:mounted,attributeName:'style',oldValue:'left:500px'});assert.equal(h.frames.size,1);
    h.runtime.dispose();
});

test('task rail removes both stale hosts before creating its dashboard-owned root',()=>{
    const renderer=fs.readFileSync(path.join(root,'src/plugins/task-rail/renderer.js'),'utf8');
    const strays=[{isConnected:true},{isConnected:true}];
    for(const stray of strays)stray.remove=()=>{stray.isConnected=false;};
    const stop=new Error('stop before owned host creation');
    const document={
        getElementById:()=>strays.find(node=>node.isConnected)||null,
        querySelectorAll:selector=>selector==='#cuimod-host'?strays.filter(node=>node.isConnected):[],
        createElement:()=>{throw stop;},
    };
    const definition=renderer.slice(0,renderer.indexOf('install(cuimod, ctx);'));
    const install=new Function('document',definition+'\nreturn install;')(document);
    assert.throws(()=>install({},{}),error=>error===stop);
    assert.deepEqual(strays.map(node=>node.isConnected),[false,false]);
});

test('legacy observe delivery is unchanged and disposal cancels every owned resource',()=>{
    const h=fixture();let observed=0;
    const legacy=h.api.observe(h.html,{childList:true},()=>observed++);
    legacy.fn([]);assert.equal(observed,1);assert.equal(h.frames.size,0);
    const schedule=h.api.layout(()=>1,()=>{});schedule.measure();
    h.runtime.dispose();
    assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);assert.equal(h.intervals.size,0);
    assert.equal(h.observers.some(o=>o.active),false);assert.equal(h.resizers.some(o=>o.active),false);
    assert.equal([...h.ctx.fixtureErrors].length,0);
});
