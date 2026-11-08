/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';

test('composer uploads preserve text, Unicode metadata and recover from failure',{timeout:40_000},async t=>{
 const browser=await chromium.launch({executablePath:process.env.NIGHTCORD_TEST_CHROMIUM||undefined});t.after(()=>browser.close());
 const root=new URL('../../',import.meta.url);
 const html=(await readFile(new URL('index.html',root),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 const scripts=await Promise.all(['purify.js','sekai-escape.js','performance-optimizer.js','event-bus.js','ai-config.js','storage-manager.js','file-upload-service.js','sekai-renderer.js','ui-autocomplete.js','user-profile.js','ui-manager.js'].map(file=>readFile(new URL(file,root),'utf8')));
 async function fixture(t){
  const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close());
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!=='http://composer.nightcord.test')return route.abort();if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'image/svg+xml',body:await readFile(new URL('.'+url.pathname,root))})});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto('http://composer.nightcord.test/?test');for(const content of scripts)await page.addScriptTag({content});
  await page.evaluate(()=>{window.ui=new UIManager(new EventBus());ui.currentRoom='nightcord-test';window.sent=[];ui.setupChatRoom(message=>{sent.push(message);return true});window.input=ui.elements.chatInput;});return page;
 }
 await t.test('upload insertion respects the beginning, middle and selection of a draft',async t=>{
  const p=await fixture(t);const result=await p.evaluate(()=>{const out=[];for(const [start,end] of [[0,0],[2,2],[1,4]]){input.value='abcdef';input.setSelectionRange(start,end);ui._insertPlaceholder(input,'[upload]');out.push(input.value)}return out});assert.deepEqual(result,['[upload]abcdef','ab[upload]cdef','a[upload]ef']);
 });
 await t.test('emoji and reserved characters survive percent encoding and filename budgets',async t=>{
  const p=await fixture(t);const cases=['曲目🎵','𠮷野家.txt','👨‍👩‍👧‍👦🎼.opus','a;=:<>% b.png'];
  const result=await p.evaluate(cases=>cases.map(name=>{const fields=[{key:'name',value:name.repeat(40),encode:true}];const token=ui._buildSekaiV2Token('Files',fields,'test-id');return {roundtrip:decodeURIComponent(ui._sekaiEncode(name)),length:token.length,name:ui.sekaiRenderer.tokenizeV2(token)[0].desc.name}}),cases);
  for(let i=0;i<cases.length;i++){assert.equal(result[i].roundtrip,cases[i]);assert.ok(result[i].length<=256);assert.ok(!result[i].name.includes('\uFFFD'));assert.ok(cases[i].repeat(40).startsWith(result[i].name));}
 });
 await t.test('clipping respects every UTF-8 budget without splitting emoji',async t=>{
  const p=await fixture(t);const result=await p.evaluate(()=>{for(let budget=0;budget<100;budget++){const clipped=ui._clipToEncodedBudget('🎵甲𠮷乙'.repeat(20),budget);if(ui._sekaiEncode(clipped).length>budget||clipped.includes('\uFFFD')||/[\uD800-\uDBFF]$/.test(clipped))return {budget,clipped}}return null});assert.equal(result,null);
 });
 await t.test('upload progress replaces only its placeholder and does not auto-send',async t=>{
  const p=await fixture(t);const result=await p.evaluate(async()=>{
   input.value='前后';input.setSelectionRange(1,1);let progressSeen;
   ui.fileUploadService.upload=async(file,name,progress)=>{progress(42);progressSeen=ui.elements.uploadPercent.textContent;return {uuid:'uploaded-id',kind:'file',size:1}};
   await ui.handleFileUpload(new File(['test'],'笔记🎵.txt',{type:'text/plain'}),'file');
   return {text:input.value,progressSeen,hidden:ui.elements.uploadProgress.classList.contains('hidden'),sent};
  });assert.ok(result.text.startsWith('前<$SEKAI:Files:'));assert.ok(result.text.endsWith('>后'));assert.match(result.text,/%F0%9F%8E%B5/);assert.equal(result.progressSeen,'42%');assert.equal(result.hidden,true);assert.deepEqual(result.sent,[]);
 });
 await t.test('failed upload removes the placeholder while preserving the draft for retry',async t=>{
  const p=await fixture(t);const result=await p.evaluate(async()=>{input.value='draft before failure';input.setSelectionRange(5,5);ui.fileUploadService.upload=async()=>{throw new Error('simulated upload failure')};await ui.handleFileUpload(new File(['test'],'note.txt',{type:'text/plain'}),'file');return {draft:input.value,hidden:ui.elements.uploadProgress.classList.contains('hidden'),message:ui.messages.at(-1).text,sent}});assert.equal(result.draft,'draft before failure');assert.equal(result.hidden,true);assert.match(result.message,/simulated upload failure/);assert.deepEqual(result.sent,[]);
 });
 await t.test('selecting the same file twice triggers two uploads and resets the file input',async t=>{
  const p=await fixture(t);await p.evaluate(()=>{window.uploads=[];ui.handleFileUpload=(file,type)=>uploads.push({name:file.name,type})});const file={name:'same.txt',mimeType:'text/plain',buffer:Buffer.from('test')};for(let i=0;i<2;i++)await p.locator('#fileInput').setInputFiles(file);assert.equal(await p.locator('#fileInput').inputValue(),'');assert.deepEqual(await p.evaluate(()=>uploads),[{name:'same.txt',type:'file'},{name:'same.txt',type:'file'}]);
 });
 await t.test('dragging text leaves the upload overlay hidden and keeps native behavior',async t=>{
  const p=await fixture(t);const result=await p.evaluate(()=>{const data=new DataTransfer();data.setData('text/plain','selected text');const results=[];for(const type of ['dragenter','dragover','drop']){const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data});input.dispatchEvent(event);results.push(event.defaultPrevented)}return {results,hidden:document.querySelector('.drag-overlay').classList.contains('hidden')}});assert.deepEqual(result.results,[false,false,false]);assert.equal(result.hidden,true);
 });
 await t.test('file drag overlay survives leaving and quickly entering again',async t=>{
  const p=await fixture(t);const result=await p.evaluate(async()=>{const data=new DataTransfer();data.items.add(new File(['test'],'note.txt'));const emit=type=>document.body.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));emit('dragleave');emit('dragenter');const visible=!document.querySelector('.drag-overlay').classList.contains('hidden');emit('dragleave');emit('dragenter');await new Promise(r=>setTimeout(r,230));const stillVisible=!document.querySelector('.drag-overlay').classList.contains('hidden');window.dropped=[];ui.handleFileUpload=(file,type)=>dropped.push({name:file.name,type});emit('drop');await new Promise(r=>setTimeout(r,230));return {visible,stillVisible,hidden:document.querySelector('.drag-overlay').classList.contains('hidden'),dropped}});assert.equal(result.visible,true);assert.equal(result.stillVisible,true);assert.equal(result.hidden,true);assert.deepEqual(result.dropped,[{name:'note.txt',type:'file'}]);
 });
 await t.test('oversized draft from programmatic insertion is preserved and rejected before sending',async t=>{
  const p=await fixture(t);await p.evaluate(()=>{input.value='x'.repeat(257)});await p.locator('#messageInput').press('Enter');assert.deepEqual(await p.evaluate(()=>sent),[]);assert.equal((await p.locator('#messageInput').inputValue()).length,257);
 });
 await t.test('clear command resets AI context without sending a public message',async t=>{
  const p=await fixture(t);await p.evaluate(()=>{window.cleared=0;ui.eventBus.on('nako:clear',()=>cleared++)});await p.locator('#messageInput').fill('/clear');await p.locator('#messageInput').press('Enter');assert.equal(await p.evaluate(()=>cleared),1);assert.deepEqual(await p.evaluate(()=>sent),[]);assert.equal(await p.locator('#messageInput').inputValue(),'');
 });
 await t.test('empty AI prompt shows feedback without sending or calling the model',async t=>{
  const p=await fixture(t);await p.evaluate(()=>{window.asks=0;ui.eventBus.on('nako:ask',()=>asks++)});await p.locator('#messageInput').fill('/nako');await p.locator('#messageInput').press('Enter');assert.equal(await p.evaluate(()=>asks),0);assert.deepEqual(await p.evaluate(()=>sent),[]);assert.equal(await p.locator('#messageInput').inputValue(),'/nako');
 });
});
