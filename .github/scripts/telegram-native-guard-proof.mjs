import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resultPath = join(process.env.RUNNER_TEMP ?? tmpdir(),'native-guard-result.json');

if(process.env.GITHUB_ACTIONS!=='true')throw new Error('This diagnostic runs only in a disposable CI runner');
const binaries=await mkdtemp(join(tmpdir(),'bloks-native-codex-'));
const assets=[
  ['codex-x86_64-unknown-linux-musl.tar.gz','306865417d4ee7a927785852910a527f41e1e159add390ac5ae3accb67d44a13','codex'],
  ['codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz','ac6cd6288f0e39f46a33eba1cfd37711651f14f33dbc73d6a1b82eb45e038cac','codex-code-mode-host'],
  ['bwrap-x86_64-unknown-linux-musl.tar.gz','1844535ea16d5454a6b5ee5df541c068ea8ddf1028ad3520255b16e05de3183d','bwrap'],
];
for(const[name,digest,binary]of assets){
  const response=await fetch('https://github.com/openai/codex/releases/download/rust-v0.160.0/'+name);
  if(!response.ok)throw new Error('Native engine download failed: '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
  const archive=join(binaries,name);await writeFile(archive,bytes);
  const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  assert.equal(entries.length,1);
  assert.match(entries[0],/^[a-z0-9._-]+$/);
  execFileSync('tar',['-xzf',archive,'-C',binaries,entries[0]]);
  await rename(join(binaries,entries[0]),join(binaries,binary));
  await chmod(join(binaries,binary),0o755);await rm(archive);
}
process.env.PATH=binaries+':'+process.env.PATH;

const codexVersion = execFileSync('codex', ['--version'], {encoding:'utf8'}).trim();
assert.equal(codexVersion, 'codex-cli 0.160.0');
const scratch = await mkdtemp(join(tmpdir(), 'bloks-pr2-native-guard-'));
const fakeHome = join(scratch, 'home');
const savedHome = join(fakeHome, '.codex');
const isolatedHome = join(scratch, 'person-codex');
const project = join(scratch, 'planning');
for(const dir of [savedHome,isolatedHome,join(project,'.git'),join(project,'.codex'),join(savedHome,'rules')])await mkdir(dir,{recursive:true});
await writeFile(join(savedHome,'rules','default.rules'),'prefix_rule(pattern=["touch"], decision="allow")\n');
await writeFile(join(project,'read.txt'),'synthetic read\n');
const mcpScript=join(scratch,'reply.mjs');
await writeFile(mcpScript,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;
let result={};if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'reply-fixture',version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'reply_to_sender',description:'Send text to the fixed synthetic sender',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:false}}]};
if(m.method==='tools/call'){const a=m.params?.arguments;if(!a||typeof a.text!=='string'||Object.keys(a).some(k=>k!=='text'))result={isError:true,content:[{type:'text',text:'invalid reply'}]};else{appendFileSync(process.argv[2],a.text+'\\n');result={content:[{type:'text',text:'sent to synthetic sender'}]};}}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
let activeCase=null;
let networkConnections=0;
const listener=createTcpServer(socket=>{networkConnections++;socket.end();});
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const networkPort=listener.address().port;
function toolsIn(list,prefix='') {
  return(list??[]).flatMap(t=>t.type==='namespace'?toolsIn(t.tools,(prefix?prefix+'.':'')+t.name):[{...t,fullName:(prefix?prefix+'.':'')+t.name}]);
}
function stream(res,item,id) {
  const response={id,object:'response',status:'completed',output:item?[item]:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const frames=[{type:'response.created',response:{...response,status:'in_progress',output:[]}}];
  if(item){frames.push({type:'response.output_item.added',output_index:0,item});frames.push({type:'response.output_item.done',output_index:0,item});}
  frames.push({type:'response.completed',response});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const frame of frames)res.write('event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n');
  res.end();
}
const http=createServer(async(req,res)=>{
  const buffers=[];for await(const b of req)buffers.push(b);
  let body;try{body=JSON.parse(Buffer.concat(buffers))}catch{res.writeHead(400);res.end();return}
  const c=activeCase;if(!c){res.writeHead(503);res.end();return}
  const extra=(body.input??[]).filter(i=>i.type==='additional_tools').flatMap(i=>i.tools??[]);
  const tools=toolsIn([...(body.tools??[]),...extra]);c.requestTools=tools.map(t=>t.fullName);
  c.requests++;
  if(c.requests>1){c.toolOutputs=(body.input??[]).filter(i=>i.type?.endsWith('_output'));stream(res,{type:'message',id:'msg_'+c.label,role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture finished',annotations:[]}]},'resp_'+c.label+'_end');return}
  let tool,item;
  const code=tools.find(t=>t.type==='custom'&&t.fullName.endsWith('.exec'));
  if(code) {
    let input;
    if(c.kind==='reply')input='const t=ALL_TOOLS.find(t=>t.name.endsWith("reply_to_sender")); if(!t)throw new Error("reply tool absent"); text(await tools[t.name]({text:"Hello Lee"}));';
    else if(c.kind==='patch')input='text(await tools.apply_patch('+JSON.stringify('*** Begin Patch\n*** Add File: '+c.marker+'\n+synthetic patch\n*** End Patch')+'));';
    else {
      const cmd=c.kind==='read'?'cat '+join(project,'read.txt'):c.kind==='network'?process.execPath+' -e '+JSON.stringify('const s=require("node:net").connect({host:"127.0.0.1",port:'+networkPort+'});s.on("connect",()=>{console.log("NETWORK_CONNECTED");s.end();});s.on("error",e=>{console.log("NETWORK_BLOCKED "+e.code);process.exitCode=1;});s.setTimeout(1000,()=>{console.log("NETWORK_BLOCKED timeout");s.destroy();process.exitCode=1;});'):'touch '+c.marker;
      const args={cmd,login:false,...(c.kind==='escalation'?{sandbox_permissions:'require_escalated',justification:'Synthetic escalation proof'}:{})};
      input='text(await tools.exec_command('+JSON.stringify(args)+'));';
    }
    tool=code;item={type:'custom_tool_call',id:'item_'+c.label,call_id:'call_'+c.label,name:code.name,namespace:'functions',input};
  }else if(c.kind==='reply') {
    tool=tools.find(t=>t.fullName.endsWith('reply_to_sender'));
    if(tool)item={type:'function_call',id:'item_'+c.label,call_id:'call_'+c.label,name:tool.fullName,arguments:JSON.stringify({text:'Hello Lee'})};
  }else if(c.kind==='patch') {
    tool=tools.find(t=>t.fullName.endsWith('apply_patch'));
    const input='*** Begin Patch\n*** Add File: '+c.marker+'\n+synthetic patch\n*** End Patch';
    if(tool)item=tool.type==='custom'?{type:'custom_tool_call',id:'item_'+c.label,call_id:'call_'+c.label,name:tool.fullName,input}:{type:'function_call',id:'item_'+c.label,call_id:'call_'+c.label,name:tool.fullName,arguments:JSON.stringify({input})};
  }else {
    tool=tools.find(t=>t.fullName.endsWith('exec_command'))??tools.find(t=>t.fullName.endsWith('shell_command'));
    const cmd=c.kind==='read'?'cat '+join(project,'read.txt'):c.kind==='network'?process.execPath+' -e '+JSON.stringify('const s=require("node:net").connect({host:"127.0.0.1",port:'+networkPort+'});s.on("connect",()=>{console.log("NETWORK_CONNECTED");s.end();});s.on("error",e=>{console.log("NETWORK_BLOCKED "+e.code);process.exitCode=1;});s.setTimeout(1000,()=>{console.log("NETWORK_BLOCKED timeout");s.destroy();process.exitCode=1;});'):'touch '+c.marker;
    const args=tool?.fullName.endsWith('exec_command')?{cmd,login:false,...(c.kind==='escalation'?{sandbox_permissions:'require_escalated',justification:'Synthetic escalation proof'}:{})}:{command:cmd,...(c.kind==='escalation'?{sandbox_permissions:'require_escalated',justification:'Synthetic escalation proof'}:{})};
    if(tool)item={type:'function_call',id:'item_'+c.label,call_id:'call_'+c.label,name:tool.fullName,arguments:JSON.stringify(args)};
  }
  if(!tool){c.providerError='expected tool not in native catalog';res.writeHead(400);res.end(JSON.stringify({error:{message:c.providerError}}));return}
  c.calledTool=tool.fullName;stream(res,item,'resp_'+c.label);
});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const address=http.address();
const provider=`model="gpt-6.1-sol"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${address.port}"\nwire_api="responses"\nrequires_openai_auth=false\n`;
await writeFile(join(savedHome,'config.toml'),provider+`[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[mcp_servers.user_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([mcpScript,join(scratch,'user-tool.txt')])}\ndefault_tools_approval_mode="approve"\n`);
await writeFile(join(project,'.codex','config.toml'),`[mcp_servers.project_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([mcpScript,join(scratch,'project-tool.txt')])}\ndefault_tools_approval_mode="approve"\n`);
await writeFile(join(isolatedHome,'config.toml'),provider);
const present=async(path)=>{try{await access(path);return true}catch{return false}};

async function run(label,kind,isolated,accept=false) {
  const marker=join(project,label+'.txt');
  const c={label,kind,isolated,marker,requests:0,approvals:[],frames:[]};activeCase=c;
  const overrides=['features.apps=false','features.plugins=false'];
  if(isolated)overrides.push(`projects={${JSON.stringify(project)}={trust_level="untrusted"}}`,`mcp_servers={reply={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([mcpScript,marker])},default_tools_approval_mode="approve"}}`);
  const child=spawn('codex',['app-server','--strict-config',...overrides.flatMap(v=>['-c',v])],{cwd:project,env:{PATH:process.env.PATH,HOME:fakeHome,CODEX_HOME:isolated?isolatedHome:savedHome,SHELL:'/bin/bash',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true});
  c.pid=child.pid;c.stderr='';child.stderr.on('data',b=>c.stderr+=b.toString());
  let serial=0,done,failed;const completion=new Promise((resolve,reject)=>{done=resolve;failed=reject});
  const pending=new Map();
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'))},12000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  child.on('exit',(code,signal)=>{for(const w of pending.values()){clearTimeout(w.timer);w.reject(new Error('native exited '+(code??signal)))}pending.clear();});
  const lines=createInterface({input:child.stdout});
  lines.on('line',async(line)=>{
    let f;try{f=JSON.parse(line)}catch{return}if(c.frames.length<300)c.frames.push(f);
    if(!f.method){const w=pending.get(f.id);if(w){pending.delete(f.id);clearTimeout(w.timer);f.error?w.reject(new Error(JSON.stringify(f.error))):w.resolve(f.result)}return}
    if(f.id!==undefined){
      const before=await present(marker);c.approvals.push({method:f.method,markerPresentBefore:before,params:f.params});
      child.stdin.write(JSON.stringify({id:f.id,result:{decision:accept?'accept':'decline'}})+'\n');
    }
    if(f.method==='turn/completed')done(f.params);
    if(f.method==='error'&&f.params?.willRetry===false)failed(new Error(JSON.stringify(f.params)));
  });
  let budget;
  try {
    await rpc('initialize',{clientInfo:{name:'bloks-fixture',version:'1'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const t=await rpc('thread/start',{cwd:project,sandbox:'read-only',approvalPolicy:'on-request',model:'gpt-6.1-sol',ephemeral:true});
    c.guard={approvalPolicy:t.approvalPolicy,sandbox:t.sandbox};
    c.status=await rpc('mcpServerStatus/list',{});
    await rpc('turn/start',{threadId:t.thread.id,input:[{type:'text',text:'Run the synthetic fixture step.'}]});
    await Promise.race([completion,new Promise((_,reject)=>{budget=setTimeout(()=>reject(new Error('native turn did not complete within 35s')),35000)})]);
    c.markerPresentAfter=await present(marker);
    if(c.markerPresentAfter)c.markerText=await readFile(marker,'utf8');
  }catch(error){c.error=String(error)}
  finally {
    clearTimeout(budget);for(const w of pending.values()){clearTimeout(w.timer);w.reject(new Error('ended'))}pending.clear();
    try{process.kill(-child.pid,'SIGTERM')}catch{}
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1000))]);
    if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL')}catch{}}
    lines.close();c.exitCode=child.exitCode;c.signalCode=child.signalCode;
  }
  console.log(JSON.stringify({label,kind,calledTool:c.calledTool,approvals:c.approvals.map(a=>({method:a.method,markerPresentBefore:a.markerPresentBefore})),marker:c.markerPresentAfter,error:c.error??null}));
  return c;
}
const results=[];
try {
  results.push(await run('isolated-write-deny','write',true));
  results.push(await run('isolated-write-accept','write',true,true));
  results.push(await run('isolated-read','read',true));
  results.push(await run('isolated-reply','reply',true));
  results.push(await run('isolated-patch-deny','patch',true));
  results.push(await run('isolated-escalation-deny','escalation',true));
  results.push(await run('isolated-network','network',true));
  const checks=[];
  function check(label,fn){try{fn();checks.push({label,passed:true});}catch(error){checks.push({label,passed:false,error:String(error)});}}
  const by=Object.fromEntries(results.map(c=>[c.label,c]));
  const output=c=>JSON.stringify(c.toolOutputs??[]);
  check('native read succeeds without approval',()=>{const c=by['isolated-read'];assert.equal(c.error,undefined);assert.equal(c.approvals.length,0);assert.match(output(c),/synthetic read/);assert.doesNotMatch(output(c),/Failed RTM_NEWADDR|Operation not permitted/);});
  check('denied write has no effect',()=>assert.equal(by['isolated-write-deny'].markerPresentAfter,false));
  check('writing command requests approval',()=>assert.ok(by['isolated-write-deny'].approvals.some(a=>a.method==='item/commandExecution/requestApproval')));
  check('accepted write is gated before effect',()=>{const c=by['isolated-write-accept'];assert.ok(c.approvals.some(a=>a.method==='item/commandExecution/requestApproval'&&!a.markerPresentBefore));assert.equal(c.markerPresentAfter,true);});
  check('patch asks before any effect',()=>{const c=by['isolated-patch-deny'];assert.ok(c.approvals.some(a=>a.method==='item/fileChange/requestApproval'&&!a.markerPresentBefore));assert.equal(c.markerPresentAfter,false);});
  check('explicit escalation asks before any effect',()=>{const c=by['isolated-escalation-deny'];assert.ok(c.approvals.some(a=>a.method==='item/commandExecution/requestApproval'&&!a.markerPresentBefore));assert.equal(c.markerPresentAfter,false);});
  check('fixed reply sends without approval',()=>{const c=by['isolated-reply'];assert.equal(c.error,undefined);assert.equal(c.approvals.length,0);assert.equal(c.markerText,'Hello Lee\n');});
  check('owner account tools absent',()=>{for(const c of results){const servers=c.status?.data??[];assert.ok(!servers.some(s=>['user_fixture','project_fixture'].includes(s.name)&&Object.keys(s.tools??{}).length));}});
  check('sandbox cannot connect to loopback',()=>{const c=by['isolated-network'];assert.equal(c.error,undefined);assert.match(output(c),/NETWORK_BLOCKED/);assert.doesNotMatch(output(c),/NETWORK_CONNECTED/);assert.equal(networkConnections,0);});
  const report={version:'0.160.0',codexVersion,localInferenceFixture:true,authenticatedInference:false,results,checks,networkConnections};
  await writeFile(resultPath,JSON.stringify(report,null,2)+'\n');
  for(const c of results)console.log('NATIVE_GUARD_CASE '+JSON.stringify({label:c.label,guard:c.guard,approvals:c.approvals,markerPresentAfter:c.markerPresentAfter,markerText:c.markerText,toolOutputs:c.toolOutputs,error:c.error,stderr:c.stderr}));
  console.log('NATIVE_GUARD_CHECKS '+JSON.stringify({checks,networkConnections}));
  console.log(JSON.stringify({checks,networkConnections}));
  console.log('NATIVE_GUARD_REPORT '+JSON.stringify(report));
  if(checks.some(c=>!c.passed))process.exitCode=1;
}finally{http.close();listener.close();await rm(scratch,{recursive:true,force:true});await rm(binaries,{recursive:true,force:true});}
