// CI-only proof for the reserve tests' call-log reader. Not part of the
// change itself: this branch only exports that reader so it can be called
// here on exact bytes, with no server or fake child running.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recorded, until } from './helpers/report-reserve.ts';

// One call as the fake's log() writes it: a JSON line ending in a newline.
const line=(x:Record<string,unknown>)=>JSON.stringify({...x,pid:4242})+'\n';
// The reader before the change, kept here only as the negative control.
const before=(file:string)=>readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));

test('an unfinished last call waits for the next read, and complete calls stay strict',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rr-calls-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'calls.jsonl');
 assert.deepEqual(recorded(file),[]);
 writeFileSync(file,line({method:'initialize'})+line({method:'thread/start'}));
 // a long turn/start cut inside its text, where the CI failures stopped
 const start=line({method:'turn/start',text:'S'.repeat(9000)});
 const cut=start.indexOf('S')+5000;
 appendFileSync(file,start.slice(0,cut));
 assert.throws(()=>before(file),/Unterminated string in JSON/);
 assert.deepEqual(recorded(file).map(c=>c.method),['initialize','thread/start']);
 // until it is finished, a call that is expected is still missing
 assert.equal(recorded(file).filter(c=>c.method==='turn/start').length,0);
 await assert.rejects(until(()=>recorded(file).some(c=>c.method==='turn/start'),'turn/start was never recorded',200),/turn\/start was never recorded/);
 appendFileSync(file,start.slice(cut));
 assert.deepEqual(recorded(file).at(-1),JSON.parse(start));
 assert.equal((await until(()=>recorded(file).find(c=>c.method==='turn/start'))).text.length,9000);
 // a complete record that is malformed still fails, as before
 appendFileSync(file,'{"method":"turn/steer","text":"unterminated\n');
 assert.throws(()=>recorded(file),/Unterminated string in JSON/);
 assert.throws(()=>before(file),/Unterminated string in JSON/);
});
