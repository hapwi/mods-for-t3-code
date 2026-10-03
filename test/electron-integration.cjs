// Executes only in the isolated Electron profile created by the TS check script.
const {app,BrowserWindow,protocol}=require('electron');
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');
app.setPath('userData',__dirname+'/profile');
protocol.registerSchemesAsPrivileged([{scheme:'t3code',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
require('./bootstrap.cjs');
let connection,w;
const snap=(threadId,id,used,max=200000)=>({thread:{id:threadId},nodes:[{id:'root-'+id,threadId,kind:'root_turn'}],providerTurns:[{id,nodeId:'root-'+id,status:'completed',tokenUsage:{usedTokens:used,maxTokens:max,updatedAt:new Date().toISOString()}}]});
function frame(value){const data=Buffer.from(JSON.stringify(value));const prefix=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);connection.write(Buffer.concat([prefix,data]));}
const server=http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({projection:snap('thread-b','b1',178000)}));});
server.on('upgrade',(req,socket)=>{const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+key+'\r\n\r\n');connection=socket;socket.on('error',()=>{});frame({_tag:'Chunk',values:[{kind:'snapshot',projection:snap('thread-a','a1',36100)}]});});
app.whenReady().then(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  protocol.handle('t3code',()=>new Response(fs.readFileSync(__dirname+'/composer.html'),{headers:{'Content-Type':'text/html'}}));
  w=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:__dirname+'/native.cjs'}});
  w.webContents.on('console-message',d=>{if(d.level==='error')console.error(d.message)});
  await w.loadURL('t3code://app/#/local/thread-a');
  await w.webContents.executeJavaScript('('+start.toString()+')('+port+')');
  frame({_tag:'Chunk',values:[{event:{type:'node.updated',threadId:'thread-a',payload:{id:'root-a2',threadId:'thread-a',kind:'root_turn'}}},{event:{type:'provider-turn.updated',threadId:'thread-a',payload:{id:'a2',nodeId:'root-a2',status:'completed',tokenUsage:{usedTokens:134400,maxTokens:200000,updatedAt:new Date().toISOString()}}}}]});
  await w.webContents.executeJavaScript('('+finish.toString()+')('+port+')');
  console.log('Electron integration passed: native preload, real WebSocket/HTTP, hash navigation, weather/chart/delta, band spacing, warm cache, custom AI bundle, live cleanup.');
  connection?.destroy();server.close();app.quit();
}).catch(e=>{console.error(e.stack);connection?.destroy();server.close();app.exit(1)});
setTimeout(()=>{console.error('Integration timeout');app.exit(1)},30000).unref();

async function start(port){
  const wait=async(f,label)=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
  await wait(()=>window.__modsForT3Code,'host boot');
  if(!window.__nativePreload||typeof require!=='undefined')throw Error('Native preload/isolation changed');
  window.__fixtureSocket=new WebSocket('ws://127.0.0.1:'+port);
  await wait(()=>window.__T3_MODS_TELEMETRY__.get()?.usedTokens===36100,'hash-route snapshot');
  await window.__modsForT3Code.importCandidate(window.__MODS_FOR_T3_OPTIONS__.examples.find(x=>x.manifest.id==='token-weather'));
  const sh=document.getElementById('mods-for-t3-code-host').shadowRoot;
  [...sh.querySelectorAll('button')].find(x=>x.textContent==='Install mod').click();
  await wait(()=>sh.querySelector('[aria-label="Enable Token weather"]')?.checked,'auto-enable');
  const band=()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('.band');
  await wait(()=>band()?.textContent.includes('36.1k / 200k'),'real worker display');
  sh.querySelector('dialog').close();
  const r=document.querySelector('[data-t3mods="bands"]').getBoundingClientRect(),s=document.querySelector('[data-chat-composer-main-surface]').getBoundingClientRect();
  if(Math.abs(s.top-r.bottom-6)>2||r.height>24)throw Error('Band spacing: '+JSON.stringify({gap:s.top-r.bottom,height:r.height}));
}
async function finish(port){
  const wait=async(f,label)=>{const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}};
  const band=()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.querySelector('.band');
  await wait(()=>band()?.textContent.includes('▲ +98.3k last turn'),'real completion/delta');
  if(!band().textContent.includes('☂ Showers')||!band().textContent.includes('67%')||band().firstElementChild.dataset.tone!=='blue')throw Error('Forecast format');
  const chart=[...band().children].find(x=>/^[▁▂▃▄▅▆▇█]+$/.test(x.textContent.trim()));if(chart?.textContent.trim().length!==2)throw Error('Chart');
  location.hash='/local/thread-b';
  await fetch('http://127.0.0.1:'+port+'/api/orchestration/threads/thread-b/bounded');
  await wait(()=>band()?.textContent.includes('178k / 200k'),'HTTP report/hash navigation');
  if(!band().textContent.includes('☇ Storm'))throw Error('New thread weather');
  location.hash='/settings/appearance';
  await wait(()=>document.querySelector('[data-t3mods="settings-section"]'),'hash Settings entry');
  await wait(()=>band()?.textContent.includes('Context usage unavailable'),'Settings clears usage');
  location.hash='/local/thread-c';
  const cache=await new Promise((resolve,reject)=>{const r=indexedDB.open('t3code:connection-runtime',4);r.onupgradeneeded=()=>r.result.createObjectStore('thread');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const projection={thread:{id:'thread-c'},nodes:[{id:'root-c1',threadId:'thread-c',kind:'root_turn'}],providerTurns:[{id:'c1',nodeId:'root-c1',status:'completed',tokenUsage:{usedTokens:172000,maxTokens:258400,updatedAt:new Date().toISOString()}}]};
  await new Promise((resolve,reject)=>{const t=cache.transaction('thread','readwrite');t.objectStore('thread').put(JSON.stringify({schemaVersion:3,threadId:'thread-c',environmentId:'local',snapshot:{projection}}),'local:thread-c');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});
  await new Promise((resolve,reject)=>{const r=cache.transaction('thread','readonly').objectStore('thread').get('local:thread-c');r.onsuccess=resolve;r.onerror=()=>reject(r.error)});
  await wait(()=>band()?.textContent.includes('172k / 258.4k'),'warm cache');cache.close();
  const custom={format:'t3mod/1',manifest:{apiVersion:1,id:'custom-counter',version:'1.0.0',name:'Custom counter',description:'Created on connected workspace',author:'Fixture',permissions:['ui.band']},code:'globalThis.T3Mod={async activate(api){await api.band.set([{text:"Custom mod works"}]);}};'};
  const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-t3mod';code.textContent=JSON.stringify(custom);pre.append(code);document.getElementById('messages').append(pre);
  const sh=document.getElementById('mods-for-t3-code-host').shadowRoot;
  await wait(()=>sh.textContent.includes('Custom counter')&&[...sh.querySelectorAll('button')].some(x=>x.textContent==='Install mod'),'remote AI bundle reaches review');
  [...sh.querySelectorAll('button')].find(x=>x.textContent==='Install mod').click();
  await wait(()=>document.querySelector('[data-t3mods="bands"]')?.shadowRoot.textContent.includes('Custom mod works'),'custom live enable');
  await window.__modsForT3Code.dispose();if(document.querySelector('iframe')||document.querySelector('[data-t3mods="bands"]'))throw Error('Cleanup');
}
