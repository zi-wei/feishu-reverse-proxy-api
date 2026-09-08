import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, AilyClient, Bridge, Timeline, normalizeRequest, conversationKey } from '../bridge.mjs';
import { createServer } from '../server.mjs';

const cfg = { model: 'aily-assistant', agentId: 'agent_test', workspaceId: '1', pollMs: 1, timeoutMs: 1000 };
const message = content => ({ role: 'user', content });
const input = (messages = [message('hello')], extra = {}) => normalizeRequest({ model: cfg.model, messages, ...extra }, cfg.model);
const event = (seq, entityType, entityId, values, extra = {}) => ({ id: `ev-${seq}`, seq, entityType, entityId,
  action: 'updated', actorType: 'agent', actorId: cfg.agentId,
  changes: Object.entries(values).map(([field,value]) => ({ field, toValue: JSON.stringify(value) })), ...extra });
const run = (seq = 1, id = 'r1', trigger) => event(seq, 'run', id, { status: 'queued',
  triggerEvents: [{ eventType: trigger ? 'comment.created' : 'task.created', entityId: trigger || 't1' }],
  triggerSourceId: trigger || '', sessionId: 'session1', sessionRunId: 'run1' }, { action: 'created' });
const comment = (seq = 2, content = 'OK', runId = 'r1') => event(seq, 'comment', 'c1', { content }, { runId, action: 'created' });
const finished = (seq = 3, id = 'r1') => event(seq, 'run', id, { status: 'completed' });

test('normalizes text parts and refuses unsupported tool, image and model requests', () => {
  assert.deepEqual(input([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]).messages, [message('ab')]);
  for (const extra of [{tools:[{type:'function'}]}, {n:2}, {stream:'true'}, {model:'fake'}, {stop:'x'}, {response_format:{type:'json_object'}}]) {
    assert.throws(() => normalizeRequest({ model:cfg.model, messages:[message('x')], ...extra }, cfg.model), ApiError);
  }
  assert.throws(() => input([{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com'}}]}]), ApiError);
  assert.deepEqual(input(undefined, { temperature: 0.7 }).ignored, ['temperature']);
});

test('timeline tolerates overlap, filters user and unrelated run content, and waits for its run', () => {
  const tracker = new Timeline({taskId:'t1',agentId:cfg.agentId});
  const events = [run(),comment(),comment(4,'other','r2'),event(5,'comment','u',{content:'private user text'},{actorType:'user'}),finished(6)];
  assert.equal(tracker.ingest({items:events}), 'OK');
  assert.equal(tracker.ingest({items:events}), 'OK');
  assert.equal(tracker.run.status, 'completed');
  assert.equal(tracker.nextSeq, 7);
  assert.throws(() => tracker.ingest({}), /missing/);
});

test('follow-up tracks only the run triggered by its own comment', () => {
  const tracker = new Timeline({taskId:'t1',commentId:'new-comment',agentId:cfg.agentId,startSeq:10});
  tracker.ingest({items:[run(10,'old','someone-else'),finished(11,'old'),run(12,'new','new-comment'),comment(13,'answer','new'),finished(14,'new')]});
  assert.equal(tracker.runId,'new');
  assert.equal([...tracker.comments.values()][0],'answer');
});

test('bridge paginates, emits actual comment arrivals and reuses matching history', async () => {
  let created = 0, continued = 0;
  const client = {
    async create() { created++; return {task:{taskId:'t1'}}; },
    async comment() { continued++; return {comment:{commentId:'u2'}}; },
    async timeline(task, seq) {
      if (seq===1) return {items:[run(),comment()],hasMore:true};
      if (seq===3) return {items:[finished()],hasMore:false};
      if (!continued) return {items:[],hasMore:false};
      return {items:[run(4,'r2','u2'),comment(5,'next','r2'),finished(6,'r2')],hasMore:false};
    },
    async usage() { return {prompt_tokens:10,completion_tokens:2,total_tokens:12}; },
  };
  const state = {}, bridge = new Bridge(cfg,client,state);
  const deltas=[];
  const first = await bridge.complete(input(undefined,{stream:true}),{onContent:d=>deltas.push(d)});
  assert.equal(first.content,'OK'); assert.deepEqual(deltas,['OK']);
  const second = await bridge.complete(input([message('hello'),{role:'assistant',content:'OK'},message('again')]));
  assert.equal(second.content,'next'); assert.equal(created,1); assert.equal(continued,1);
  assert.equal(Object.keys(state).length,1);
});

test('external edits invalidate a conversation mapping before continuation', async () => {
  const prefix=[message('hello'),{role:'assistant',content:'OK'}];
  const state={[conversationKey(prefix,cfg.model)]:{taskId:'old',nextSeq:4}};
  let creates=0;
  const client={
    async timeline(task) { return task==='old'?{items:[comment(4,'external')]}:{items:[run(),comment(),finished()],hasMore:false}; },
    async create() {creates++;return {task:{taskId:'t1'}};},
    async comment() {throw Error('Must not continue externally modified tasks.');},
    async usage() {},
  };
  await new Bridge(cfg,client,state).complete(input([...prefix,message('next')]));
  assert.equal(creates,1);
});

test('run failures and timeout reasons remain structured errors', async () => {
  const client={async create(){return {task:{taskId:'t1'}};},async timeline(){return {items:[run(),event(2,'run','r1',{status:'failed',errorMessage:'quota exceeded'})],hasMore:false};}};
  const bridge=new Bridge(cfg,client);
  await assert.rejects(bridge.complete(input()),e=>e.code==='upstream_run_failed'&&e.message.includes('quota exceeded'));
  assert.equal(bridge.active,0);
  const controller=new AbortController();
  const pending=new Bridge(cfg,{...client,async timeline(){return {items:[],hasMore:false};}}).complete(input(),{signal:controller.signal});
  setTimeout(()=>controller.abort(new ApiError(504,'upstream_timeout','Timed out')),5);
  await assert.rejects(pending,e=>e.status===504&&e.code==='upstream_timeout');
});

test('upstream authentication errors never follow redirects or retry task creation', async () => {
  let calls=0;
  const client=new AilyClient(cfg,{headers:{cookie:'secret'}},async (url,options)=>{
    calls++; assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://accounts.feishu.cn'}});
  });
  await assert.rejects(client.create('test'),e=>e.code==='aily_login_required');
  assert.equal(calls,1);
});

test('HTTP surface authenticates, returns standard JSON, emits SSE and rejects invalid requests before upstream calls', async t => {
  let calls=0;
  const bridge={active:0,async complete(value,callbacks){calls++;callbacks.onStart('t1');callbacks.onContent('hello');return {content:'hello',usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}};}};
  const server=createServer(cfg,{apiKey:'test-key'},bridge);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:'Bearer test-key','content-type':'application/json'};
  assert.equal((await fetch(base+'/v1/models')).status,401);
  assert.equal((await (await fetch(base+'/v1/models',{headers})).json()).data[0].id,cfg.model);
  const payload={model:cfg.model,messages:[message('hi')]};
  const normal=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(normal.headers.get('x-aily-task-id'),'t1');
  assert.equal((await normal.json()).choices[0].message.content,'hello');
  const stream=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...payload,stream:true,stream_options:{include_usage:true}})});
  const data=(await stream.text()).split('\n\n').filter(Boolean).map(line=>line.slice(6));
  assert.equal(data.at(-1),'[DONE]');
  assert.equal(JSON.parse(data[0]).choices[0].delta.role,'assistant');
  assert.equal(JSON.parse(data[1]).choices[0].delta.content,'hello');
  assert.equal(JSON.parse(data[2]).choices[0].finish_reason,'stop');
  assert.equal(JSON.parse(data[3]).usage.total_tokens,3);
  const invalid=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{broken'});
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'invalid_json');
  assert.equal(calls,2);
});
