import test from "node:test";
import assert from "node:assert/strict";
import {RpcSession, RpcTarget} from "../dist/index.js";
const settle = async () => { for (let i=0; i<4; i++) await new Promise(setImmediate); };
function transportPair() {
  const boxes = Array.from({length:2}, () => ({queue:[], waiter:null, closed:null}));
  return boxes.map((inbox,i) => ({
    send(message) { const out=boxes[1-i]; if(out.waiter) { out.waiter.resolve(message); out.waiter=null; } else out.queue.push(message); },
    receive() { if(inbox.queue.length) return Promise.resolve(inbox.queue.shift()); if(inbox.closed) return Promise.reject(inbox.closed); inbox.waiter=Promise.withResolvers(); return inbox.waiter.promise; },
    failReceive(reason) { inbox.closed=reason; inbox.waiter?.reject(reason); inbox.waiter=null; },
    abort(reason) { this.failReceive(reason); this.onAbort?.(reason); },
  }));
}
class Thing extends RpcTarget { ping() { return 'ok'; } }
class Main extends RpcTarget { make() { return new Thing(); } delayed() { return this.gate.promise; } fail() { throw Error('remote failure'); } }
function fixture() {
  const [clientTransport, serverTransport] = transportPair();
  const target = new Main(); target.gate=Promise.withResolvers();
  const server = new RpcSession(serverTransport,target);
  const client = new RpcSession(clientTransport);
  const main=client.getRemoteMain();
  return {client, server, main, target, clientTransport,
    async breakClient() { clientTransport.failReceive(Error('connection lost')); await settle(); },
    async close() { clientTransport.failReceive(Error('test done')); serverTransport.failReceive(Error('test done')); await settle(); },
  };
}
test('final reference disposal unregisters callbacks and remains idempotent', {timeout:2000}, async()=>{
 const f=fixture(); try {
  let fired=0; const thing=await f.main.make(); thing.onRpcBroken(()=>fired++);
  const second=thing.dup(); thing[Symbol.dispose](); second[Symbol.dispose](); second[Symbol.dispose]();
  await settle(); assert.deepEqual(f.client.getStats(),{imports:1,exports:1});
  await f.breakClient(); assert.equal(fired,0);
 } finally { await f.close(); }
});
test('same-session resolution preserves global callback registration order', {timeout:2000}, async()=>{
 const f=fixture(); try {
  const seen=[]; const pending=f.main.delayed(); pending.onRpcBroken(()=>seen.push('first'));
  const other=await f.main.make(); other.onRpcBroken(()=>seen.push('middle'));
  pending.onRpcBroken(()=>seen.push('last'));
  f.target.gate.resolve(new Thing()); const resolved=await pending;
  assert.equal(await resolved.ping(),'ok'); await f.breakClient();
  assert.deepEqual(seen,['first','middle','last']);
 } finally { await f.close(); }
});
test('session abort notifies pending entries in order despite reentrant disposal and consumer throw', {timeout:2000}, async()=>{
 const f=fixture(); try {
  const seen=[]; const a=await f.main.make(), b=await f.main.make(), c=await f.main.make();
  a.onRpcBroken(()=>{seen.push('a'); b[Symbol.dispose](); c[Symbol.dispose]();});
  b.onRpcBroken(()=>{seen.push('b'); throw Error('consumer failure');});
  c.onRpcBroken(()=>seen.push('c'));
  await f.breakClient(); assert.deepEqual(seen,['a','b','c']);
 } finally { await f.close(); }
});

test('same-session transferred callbacks unregister after all resolved references dispose', {timeout:2000}, async()=>{
 const f=fixture(); try {
  let fired=0; const pending=f.main.delayed(); pending.onRpcBroken(()=>fired++);
  f.target.gate.resolve(new Thing()); const resolved=await pending; const second=resolved.dup();
  resolved[Symbol.dispose](); second[Symbol.dispose](); await settle();
  assert.deepEqual(f.client.getStats(),{imports:1,exports:1});
  await f.breakClient(); assert.equal(fired,0);
 } finally { await f.close(); }
});
test('resolve callback consumer throw does not strand the RPC result or abort other capabilities', {timeout:2000}, async()=>{
 const f=fixture(); let timer; try {
  const other=await f.main.make(), seen=[];
  const pending=f.main.fail(); pending.onRpcBroken(()=>{seen.push('first'); throw Error('consumer failure');});
  pending.onRpcBroken(()=>seen.push('last'));
  const result=await Promise.race([
   Promise.resolve(pending).then(()=>({status:'fulfilled'}),e=>({status:'rejected',message:e.message})),
   new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout'}),150);}),
  ]);
  clearTimeout(timer); assert.deepEqual(result,{status:'rejected',message:'remote failure'});
  assert.deepEqual(seen,['first','last']); assert.equal(await other.ping(),'ok');
 } finally { clearTimeout(timer); await f.close(); }
});
test('resolve callback reentrant session abort notifies later callbacks exactly once in original order', {timeout:2000}, async()=>{
 const f=fixture(); let timer; try {
  const other=await f.main.make(), seen=[];
  const pending=f.main.fail(); pending.onRpcBroken(()=>{seen.push('first'); f.main[Symbol.dispose]();});
  other.onRpcBroken(()=>seen.push('middle')); pending.onRpcBroken(()=>seen.push('last'));
  const result=await Promise.race([
   Promise.resolve(pending).then(()=> 'fulfilled',()=> 'rejected'),
   new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),150);}),
  ]);
  clearTimeout(timer); assert.equal(result,'rejected');
  assert.deepEqual(seen,['first','middle','last']);
 } finally { clearTimeout(timer); await f.close(); }
});
test('transport abort reentrant disposal cannot remove pending notifications', {timeout:2000}, async()=>{
 const f=fixture(); try {
  const seen=[]; const a=await f.main.make(), b=await f.main.make();
  a.onRpcBroken(()=>seen.push('a')); b.onRpcBroken(()=>seen.push('b'));
  f.clientTransport.onAbort=()=>b[Symbol.dispose]();
  await f.breakClient(); assert.deepEqual(seen,['a','b']);
 } finally { await f.close(); }
});
test('registering a broken callback during session abort reports the error immediately', {timeout:2000}, async()=>{
 const f=fixture(); try {
  const seen=[]; const a=await f.main.make(), b=await f.main.make();
  a.onRpcBroken(()=>{seen.push('a'); b.onRpcBroken(()=>seen.push('new'));});
  b.onRpcBroken(()=>seen.push('b'));
  await f.breakClient(); assert.deepEqual(seen,['a','new','b']);
 } finally { await f.close(); }
});
