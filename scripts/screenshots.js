// Captures a copilot-with-plan view, which the main UI suite cannot reach
// without a real API key. Uses a local mock that speaks the Mesh wire format.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(),'shot-'));
process.env.GITSYNAPSE_CONFIG_DIR = path.join(sandbox,'config');
const repoPath = path.join(sandbox,'demo'); fs.mkdirSync(repoPath,{recursive:true});
const g=(a)=>spawnSync('git',a,{cwd:repoPath,encoding:'utf8'});
g(['init','--initial-branch=main','-q']); g(['config','user.email','a@b.c']); g(['config','user.name','You']);
g(['remote','add','origin','https://github.com/you/demo.git']);
fs.writeFileSync(path.join(repoPath,'index.js'),'export const greet = (n) => `Hi ${n}`;\n'); g(['add','.']); g(['commit','-qm','Initial commit']);
fs.writeFileSync(path.join(repoPath,'app.css'),'body{margin:0}\n');
fs.appendFileSync(path.join(repoPath,'index.js'),"export const bye = (n) => `Bye ${n}`;\n");
g(['add','app.css']);
// mock Mesh
const mock = http.createServer((req,res)=>{
  if (req.url.endsWith('/models')) { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({data:[{id:'mock/model'}]})); }
  let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const d=(c)=>`data: ${JSON.stringify({choices:[{delta:{content:c}}]})}\n\n`;
    const plan={summary:'Stage the stylesheet and commit both changes',steps:[
      {args:['add','--','app.css'],why:'Stage the new stylesheet',risk:'safe'},
      {args:['status','--short'],why:'Confirm what is staged before committing',risk:'safe'},
      {args:['commit','-m','Add stylesheet and farewell helper'],why:'Record the change as one commit',risk:'writes'}]};
    res.write(d('You have a **staged** new stylesheet and an unstaged edit to `index.js`.\n\nI would stage the stylesheet and commit both changes together:\n\n'));
    res.write(d('```gitplan\n'+JSON.stringify(plan)+'\n```'));
    res.write(`data: ${JSON.stringify({choices:[{delta:{}}],usage:{total_tokens:412}})}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
// Resolved from this file, so the script works from any checkout location and
// under any directory name.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { createApp } = await import(path.join(root, 'src/server/index.js'));
const server = createApp().listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
const base = `http://127.0.0.1:${server.address().port}`;
await fetch(`${base}/api/ai/settings`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({apiKey:'rsk_mock',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,model:'anthropic/claude-3.5-sonnet'})});
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage(); await page.setViewport({width:1500,height:940,deviceScaleFactor:2});
page.on('pageerror',e=>console.log('PAGEERROR:',e.message));
await page.goto(base,{waitUntil:'networkidle0'});
await page.evaluate(async p=>{await fetch('/api/repo/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});},repoPath);
await page.reload({waitUntil:'networkidle0'});
await page.waitForSelector('.file-row');
await page.evaluate(()=>document.querySelector('.file-row').click());
await page.waitForSelector('.diff-body');
await page.type('#chat-input','stage my css and commit everything');
await page.click('#btn-send');
await page.waitForSelector('.plan',{timeout:15000});
await new Promise(r=>setTimeout(r,600));
await page.screenshot({path:'screenshots/08-copilot-plan.png'});
await page.click('.plan .step .btn');      // open the approval sheet
await page.waitForSelector('.modal');
await new Promise(r=>setTimeout(r,400));
await page.screenshot({path:'screenshots/09-approval-sheet.png'});
console.log('captured');
await browser.close(); mock.close(); server.close(); fs.rmSync(sandbox,{recursive:true,force:true});
