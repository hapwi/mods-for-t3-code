// Executes only in the isolated Electron profile created by the TS check script.
const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
app.setPath('userData',__dirname+'/profile');
protocol.registerSchemesAsPrivileged([{scheme:'t3code',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
require('./bootstrap.cjs');
let connection,w;
const snap=(threadId,id,used,max=200000)=>({thread:{id:threadId},nodes:[{id:'root-'+id,threadId,kind:'root_turn'}],providerTurns:[{id,nodeId:'root-'+id,status:'completed',tokenUsage:{usedTokens:used,maxTokens:max,updatedAt:new Date().toISOString()}}]});
const custom={format:'t3mod/1',manifest:{apiVersion:1,id:'custom-counter',version:'1.0.0',name:'Custom counter',description:'Created on connected workspace',author:'Fixture',permissions:['ui.band']},code:'globalThis.T3Mod={async activate(api){await api.band.set([{text:"Custom mod works"}]);}};'};
function frame(value){const data=Buffer.from(JSON.stringify(value));const prefix=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);connection.write(Buffer.concat([prefix,data]));}
const server=http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({projection:req.url.includes('thread-custom')?{thread:{id:'thread-custom'},nodes:[],messages:[{id:'custom-reply',threadId:'thread-custom',role:'assistant',streaming:false,text:'Created your mod.\n```t3mod-manifest\n'+JSON.stringify(custom.manifest)+'\n```\n```t3mod-code\n'+custom.code+'\n```'}]}:snap('thread-b','b1',178000)}));});
server.on('upgrade',(req,socket)=>{const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+key+'\r\n\r\n');connection=socket;socket.on('error',()=>{});frame({_tag:'Chunk',values:[{kind:'snapshot',projection:snap('thread-a','a1',36100)}]});});
app.whenReady().then(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  // Match the packaged app policy; a fixture without CSP can hide worker failures.
  const policy="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com; connect-src 'self' blob: http: https: ws: wss:; img-src 'self' t3code: blob: data: http: https:; media-src 'self' t3code: blob: http: https:; style-src 'self' 'unsafe-inline'; font-src 'self' t3code: data:; worker-src 'self' blob:; frame-src 'self' blob: http: https:; form-action 'self'";
  protocol.handle('t3code',()=>new Response(fs.readFileSync(__dirname+'/composer.html'),{headers:{'Content-Type':'text/html','Content-Security-Policy':policy}}));
  w=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:__dirname+'/native.cjs'}});
  ipcMain.handle('fixture-remount',()=>w.webContents.executeJavaScript(fs.readFileSync(__dirname+'/renderer.js','utf8')));
  w.webContents.on('console-message',d=>{if(d.level==='error')console.error(d.message)});
  await w.loadURL('t3code://app/#/local/thread-a');
  const legacyPath=__dirname+'/legacy-token-weather.json';
  const legacy=fs.existsSync(legacyPath)?JSON.parse(fs.readFileSync(legacyPath,'utf8')):null;
  await w.webContents.executeJavaScript('('+start.toString()+')('+port+','+JSON.stringify(legacy)+')');
  frame({_tag:'Chunk',values:[{event:{type:'node.updated',threadId:'thread-a',payload:{id:'root-a2',threadId:'thread-a',kind:'root_turn'}}},{event:{type:'provider-turn.updated',threadId:'thread-a',payload:{id:'a2',nodeId:'root-a2',status:'completed',tokenUsage:{usedTokens:134400,maxTokens:200000,updatedAt:new Date().toISOString()}}}}]});
  if(legacy){
    await w.webContents.executeJavaScript('('+weatherUpgradeFinish.toString()+')()');
    console.log('Electron integration passed: old installed weather upgrades, empty/first-turn placeholders hidden, history preserved, second-turn delta appears.');
  }else{
    await w.webContents.executeJavaScript('('+finish.toString()+')('+port+')');
    console.log('Electron integration passed: native CSP/preload, blank/first-turn weather, opaque band, real WebSocket/HTTP, delta, native AI handoff, persistent review, installed/built-in editing, live toggle and cleanup.');
  }
  connection?.destroy();server.close();app.quit();
}).catch(e=>{console.error(e.stack);connection?.destroy();server.close();app.exit(1)});
setTimeout(()=>{console.error('Integration timeout');app.exit(1)},30000).unref();

async function start(port,legacy){
  const wait=async(f,label)=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
  await wait(()=>window.__modsForT3Code,'host boot');
  if(!window.__nativePreload||typeof require!=='undefined')throw Error('Native preload/isolation changed');
  if(legacy){
    await window.__modsForT3Code.dispose();
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mods-for-t3-code-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    await new Promise((resolve,reject)=>{const t=db.transaction(['mods','data'],'readwrite');t.objectStore('mods').put({...legacy,enabled:true,quarantined:null});t.objectStore('data').put({history:{version:1,threads:[['unrelated-thread',[['saved',42000]]]]},sentinel:'Keep my data'},'token-weather');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});
    await window.__fixtureRemount();
    await wait(()=>window.__modsForT3Code,'upgraded host boot');
    const stored=await new Promise((resolve,reject)=>{const r=db.transaction('mods').objectStore('mods').get('token-weather');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    if(stored.code!==window.__MODS_FOR_T3_OPTIONS__.examples.find(x=>x.manifest.id==='token-weather').code||!stored.enabled)throw Error('Legacy installed bundle was not upgraded');
    const data=await new Promise((resolve,reject)=>{const r=db.transaction('data').objectStore('data').get('token-weather');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    if(data.sentinel!=='Keep my data'||data.history.threads[0][1][0][1]!==42000)throw Error('Upgrade changed private data');
    db.close();window.__modsForT3Code.open('installed');
  }else await window.__modsForT3Code.importCandidate(window.__MODS_FOR_T3_OPTIONS__.examples.find(x=>x.manifest.id==='token-weather'));
  const sh=document.getElementById('mods-for-t3-code-host').shadowRoot;
  if(!legacy)[...sh.querySelectorAll('button')].find(x=>x.textContent==='Install mod').click();
  await wait(()=>sh.querySelector('[aria-label="Enable Token weather"]')?.checked,'auto-enable');
  const band=()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('.band');
  await wait(()=>sh.querySelector('[data-mod="token-weather"] [data-state="active"]'),'weather ready without usage');
  if(band())throw Error('Blank conversation shows a weather placeholder');
  window.__fixtureSocket=new WebSocket('ws://127.0.0.1:'+port);
  await wait(()=>window.__T3_MODS_TELEMETRY__.get()?.usedTokens===36100,'hash-route snapshot');
  await wait(()=>band()?.textContent.includes('36.1k / 200k'),'real worker display');
  if(/unknown|first turn|last turn|Δ/.test(band().textContent))throw Error('First measured turn shows a delta placeholder');
  window.__modsForT3Code.open('examples');
  await wait(()=>sh.querySelector('[aria-label="Enable Token weather"]')?.checked,'built-in reflects installation');
  await wait(()=>sh.querySelector('[data-mod="token-weather"] [data-state="active"]'),'built-in active state');
  sh.querySelector('dialog').close();
  const r=document.querySelector('[data-t3mods="bands"]').getBoundingClientRect(),s=document.querySelector('[data-chat-composer-main-surface]').getBoundingClientRect();
  if(Math.abs(s.top-r.bottom)>2||r.height>24)throw Error('Band spacing: '+JSON.stringify({gap:s.top-r.bottom,height:r.height}));
  const stack=document.querySelector('[data-t3mods="bands"]').shadowRoot.querySelector('.band-stack');
  if(getComputedStyle(stack).backgroundColor!==getComputedStyle(document.body).backgroundColor)throw Error('Weather strip does not mask conversation text');
  const strip=stack.getBoundingClientRect(),stash=document.querySelector('[data-slot="composer-banner-attachment"]>div').getBoundingClientRect();
  if(strip.right>stash.left)throw Error('Weather strip covers Stash');
}
async function weatherUpgradeFinish(){
  const end=Date.now()+7000;
  const band=()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('.band');
  while(!band()?.textContent.includes('▲ +98.3k last turn')){if(Date.now()>end)throw Error('Upgraded weather did not show the second-turn delta');await new Promise(r=>setTimeout(r,25));}
  if(/unknown|first turn/.test(band().textContent))throw Error('Upgraded weather still shows a placeholder');
  await window.__modsForT3Code.dispose();
}
async function finish(port){
  const wait=async(f,label)=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
  const band=()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('.band');
  await wait(()=>band()?.textContent.includes('▲ +98.3k last turn'),'real completion/delta');
  if(!band().textContent.includes('☂ Showers')||!band().textContent.includes('67%')||band().firstElementChild.dataset.tone!=='blue')throw Error('Forecast format');
  const chart=[...band().children].find(x=>/^[▁▂▃▄▅▆▇█]+$/.test(x.textContent.trim()));if(chart)throw Error('Unexpected sparkline bar');
  location.hash='/local/thread-b';
  await fetch('http://127.0.0.1:'+port+'/api/orchestration/threads/thread-b/bounded');
  await wait(()=>band()?.textContent.includes('178k / 200k'),'HTTP report/hash navigation');
  if(!band().textContent.includes('☇ Storm'))throw Error('New thread weather');
  location.hash='/settings/appearance';
  await wait(()=>document.querySelector('[data-t3mods="settings-section"]'),'hash Settings entry');
  await wait(()=>!band(),'Settings clears weather without a placeholder');
  location.hash='/local/thread-c';
  const cache=await new Promise((resolve,reject)=>{const r=indexedDB.open('t3code:connection-runtime',4);r.onupgradeneeded=()=>r.result.createObjectStore('thread');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const projection={thread:{id:'thread-c'},nodes:[{id:'root-c1',threadId:'thread-c',kind:'root_turn'}],providerTurns:[{id:'c1',nodeId:'root-c1',status:'completed',tokenUsage:{usedTokens:172000,maxTokens:258400,updatedAt:new Date().toISOString()}}]};
  await new Promise((resolve,reject)=>{const t=cache.transaction('thread','readwrite');t.objectStore('thread').put(JSON.stringify({schemaVersion:3,threadId:'thread-c',environmentId:'local',snapshot:{projection}}),'local:thread-c');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});
  await new Promise((resolve,reject)=>{const r=cache.transaction('thread','readonly').objectStore('thread').get('local:thread-c');r.onsuccess=resolve;r.onerror=()=>reject(r.error)});
  await wait(()=>band()?.textContent.includes('172k / 258.4k'),'warm cache');cache.close();
  // No rendered JSON, file inbox or mocked API: use a native completed response.
  location.hash='/local/thread-custom';
  await fetch('http://127.0.0.1:'+port+'/api/orchestration/threads/thread-custom/bounded');
  let sh=document.getElementById('mods-for-t3-code-host').shadowRoot;
  window.__modsForT3Code.open('installed');
  await wait(()=>sh.querySelector('[data-pending="custom-counter"]'),'native AI bundle reaches pending list without rendered JSON');
  sh.querySelector('[data-pending="custom-counter"] button.primary').click();
  sh.querySelector('dialog').close();window.__modsForT3Code.open();
  if(![...sh.querySelectorAll('button')].some(x=>x.textContent==='Install mod'))throw Error('Closing manager lost pending review');
  // Recreate the renderer host against the same isolated profile; pending survives.
  await window.__modsForT3Code.dispose();
  await window.__fixtureRemount();
  await wait(()=>window.__modsForT3Code,'renderer remount');
  sh=document.getElementById('mods-for-t3-code-host').shadowRoot;
  window.__modsForT3Code.open('installed');
  await wait(()=>sh.querySelector('[data-pending="custom-counter"]'),'pending persistence after remount');
  sh.querySelector('[data-pending="custom-counter"] button.primary').click();
  [...sh.querySelectorAll('button')].find(x=>x.textContent==='Install mod').click();
  await wait(()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.textContent.includes('Custom mod works'),'custom live enable');
  await wait(()=>sh.querySelector('[data-mod="custom-counter"] [data-state="active"]'),'installed active state');
  const enabled=()=>sh.querySelector('[aria-label="Enable Custom counter"]');
  enabled().click();
  await wait(()=>!document.querySelector('[data-t3mods="bands"]')?.shadowRoot.textContent.includes('Custom mod works'),'live disable');
  await wait(()=>!enabled()?.disabled,'toggle ready');enabled().click();
  await wait(()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.textContent.includes('Custom mod works'),'live re-enable');
  // Edits draft the existing code into the native paste path without submitting.
  const editor=document.querySelector('[data-testid="composer-editor"]');
  editor.addEventListener('paste',event=>{event.preventDefault();editor.textContent=event.clipboardData.getData('text/plain');});
  const editRow=(selector)=>{sh.querySelector(selector+' button[aria-label^="More actions"]').click();[...sh.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent==='Edit').click();};
  const draftChange=async(name,text)=>{
    const field=sh.querySelector('[aria-label="Changes for '+name+'"]');field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));
    [...sh.querySelectorAll('button')].find(x=>x.textContent==='Draft in T3').click();
    await wait(()=>editor.textContent.includes('What I want changed: '+text),'edit request reaches composer');
  };
  window.__modsForT3Code.open('installed');editRow('[data-mod="custom-counter"]');
  [...sh.querySelectorAll('button')].find(x=>x.textContent==='Draft in T3').click();
  await wait(()=>sh.querySelector('[role="alert"]')?.textContent.includes('Describe what should change'),'edit validates empty changes');
  await draftChange('Custom counter','Also show a short greeting');
  if(!editor.textContent.includes('Custom mod works')||!editor.textContent.includes('"custom-counter"')||!editor.textContent.includes('higher SemVer'))throw Error('Edit request lacks installed source or update contract');
  if(!document.querySelector('[data-t3mods="bands"]')?.shadowRoot.textContent.includes('Custom mod works'))throw Error('Editing stopped the installed mod');
  window.__modsForT3Code.open('examples');editRow('[data-example="context-usage"]');
  await draftChange('Context Usage','Use shorter labels');
  if(!editor.textContent.includes('not installed yet')||!editor.textContent.includes('api.context.show'))throw Error('Uninstalled built-in is not editable');
  const original=window.__MODS_FOR_T3_OPTIONS__.examples.find(x=>x.manifest.id==='token-weather');
  await window.__modsForT3Code.importCandidate({...original,manifest:{...original.manifest,version:'1.1.0'},code:original.code+'\n// Installed customization'});
  [...sh.querySelectorAll('button')].find(x=>x.textContent==='Update mod').click();
  await wait(()=>sh.querySelector('[data-mod="token-weather"] [data-state="active"]'),'customized builtin active');
  window.__modsForT3Code.open('examples');editRow('[data-example="token-weather"]');
  await draftChange('Token weather','Use shorter weather names');
  if(!editor.textContent.includes('Installed customization')||!editor.textContent.includes('version 1.1.0'))throw Error('Built-in edit lost installed customization');
  await window.__modsForT3Code.dispose();if(document.querySelector('iframe')||document.querySelector('[data-t3mods="bands"]'))throw Error('Cleanup');
}
