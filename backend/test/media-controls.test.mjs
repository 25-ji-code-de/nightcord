/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright';

const wav=Buffer.alloc(44+8000*2*4);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<32000;i++)wav.writeInt16LE(Math.round(1000*Math.sin(i*2*Math.PI*220/8000)),44+i*2);

test('media playback, seeking, keyboard access and rich content controls', {timeout:60_000},async t=>{
 const browser=await chromium.launch({executablePath:process.env.NIGHTCORD_TEST_CHROMIUM||undefined,args:['--mute-audio']});t.after(()=>browser.close());
 const sources=await Promise.all(['purify.js','sekai-renderer.js'].map(async file=>await readFile(new URL('../../'+file,import.meta.url),'utf8')));
 const css=await readFile(new URL('../../css/renderer.css',import.meta.url),'utf8');
 async function fixture(t,{touch=false}={}){
  const context=await browser.newContext({viewport:{width:640,height:800},hasTouch:touch});t.after(()=>context.close());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.route('**/*',route=>{
   if(!route.request().url().endsWith('.wav'))return route.fulfill({contentType:'text/html',body:'<!doctype html><main id="test"></main>'});
   const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
   const start=range?Number(range[1]):0;const end=range&&range[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
   return route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${wav.length}`}:{})},body:wav.subarray(start,end+1)});
  });
  await page.goto('http://media.nightcord.test/');for(const content of sources)await page.addScriptTag({content});await page.addStyleTag({content:css});
  await page.evaluate(()=>{window.renderer=new SekaiRenderer();window.mount=kind=>{const player=kind==='music'?renderer.renderMusic('/test.wav','Title','Artist','0:04'):renderer.renderAudio('/test.wav','0:04');document.querySelector('#test').replaceChildren(player);window.audio=player.querySelector('audio');return player.className}});
  return page;
 }
 for(const kind of ['simple','music']){
  await t.test(`${kind}: actual playback, external pause and natural end reset the controls`,async t=>{
   const p=await fixture(t);await p.evaluate(kind=>mount(kind),kind);await p.waitForFunction(()=>audio.readyState>=1);
   await p.getByRole('button',{name:'Play',exact:true}).click();await p.waitForFunction(()=>!audio.paused&&audio.currentTime>0);
   assert.equal(await p.getByRole('button',{name:'Pause',exact:true}).count(),1);
   await p.evaluate(()=>audio.pause());await p.waitForFunction(()=>!document.querySelector('.playing'));
   assert.equal(await p.getByRole('button',{name:'Play',exact:true}).count(),1);
   await p.evaluate(()=>audio.currentTime=audio.duration-0.1);await p.getByRole('button',{name:'Play',exact:true}).click();
   await p.waitForFunction(()=>!document.querySelector('.playing')&&audio.paused);
   assert.equal(await p.getByRole('button',{name:'Play',exact:true}).count(),1);
  });
  await t.test(`${kind}: rejected playback remains stopped and can be retried`,async t=>{
   const p=await fixture(t);await p.evaluate(kind=>mount(kind),kind);await p.waitForFunction(()=>audio.readyState>=1);
   await p.evaluate(()=>{window.realPlay=audio.play;audio.play=()=>Promise.reject(new Error('test playback rejection'))});
   await p.getByRole('button',{name:'Play',exact:true}).click();assert.match(await p.locator('.sekai-audio-time').textContent(),/无法播放/);
   assert.equal(await p.locator('.playing').count(),0);await p.evaluate(()=>audio.play=realPlay);
   await p.getByRole('button',{name:'Play',exact:true}).click();await p.waitForFunction(()=>!audio.paused);await p.evaluate(()=>audio.pause());
  });
  await t.test(`${kind}: keyboard seeking clamps to both ends and exposes its value`,async t=>{
   const p=await fixture(t);await p.evaluate(kind=>mount(kind),kind);await p.waitForFunction(()=>audio.readyState>=1);
   const slider=p.getByRole('slider',{name:'播放进度'});await slider.focus();await slider.press('End');
   const end=await p.evaluate(()=>({time:audio.currentTime,duration:audio.duration,seekable:audio.seekable.length,ready:audio.readyState,value:document.querySelector('[role=slider]').getAttribute('aria-valuenow')}));assert.ok(Math.abs(end.time-end.duration)<0.01,JSON.stringify(end));
   await slider.press('Home');assert.ok(await p.evaluate(()=>audio.currentTime<0.01));
   await slider.press('ArrowRight');assert.ok(await p.evaluate(()=>Math.abs(audio.currentTime/audio.duration-0.05)<0.01));
   assert.equal(await slider.getAttribute('aria-valuenow'),'5');
  });
  await t.test(`${kind}: pointer capture seeks outside the track without document listeners`,async t=>{
   const p=await fixture(t);await p.evaluate(kind=>mount(kind),kind);await p.waitForFunction(()=>audio.readyState>=1);
   const slider=p.getByRole('slider',{name:'播放进度'});const rect=await slider.boundingBox();
   await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.down();await p.mouse.move(rect.x+rect.width+15,rect.y+rect.height/2);await p.mouse.up();
   const end=await p.evaluate(()=>({time:audio.currentTime,duration:audio.duration,seekable:audio.seekable.length,ready:audio.readyState,value:document.querySelector('[role=slider]').getAttribute('aria-valuenow')}));assert.ok(Math.abs(end.time-end.duration)<0.02,JSON.stringify(end));
  });
  await t.test(`${kind}: touch can seek without triggering page scrolling`,async t=>{
   const p=await fixture(t,{touch:true});await p.evaluate(kind=>mount(kind),kind);await p.waitForFunction(()=>audio.readyState>=1);
   const rect=await p.getByRole('slider',{name:'播放进度'}).boundingBox();await p.touchscreen.tap(rect.x+rect.width/2,rect.y+rect.height/2);
   const middle=await p.evaluate(()=>({time:audio.currentTime,duration:audio.duration,seekable:audio.seekable.length,ready:audio.readyState,value:document.querySelector('[role=slider]').getAttribute('aria-valuenow')}));assert.ok(Math.abs(middle.time/middle.duration-0.5)<0.06,JSON.stringify(middle));
  });
 }
 await t.test('volume starts at the visible setting and supports keyboard changes',async t=>{
  const p=await fixture(t);await p.evaluate(()=>mount('music'));assert.equal(await p.evaluate(()=>audio.volume),0.8);
  const slider=p.getByRole('slider',{name:'音量'});await slider.focus();await slider.press('Home');assert.equal(await p.evaluate(()=>audio.volume),0);
  await slider.press('End');assert.equal(await p.evaluate(()=>audio.volume),1);assert.equal(await slider.getAttribute('aria-valuenow'),'100');
 });
 await t.test('rebuilding 100 audio players adds no global drag listeners',async t=>{
  const p=await fixture(t);const count=await p.evaluate(()=>{let count=0;const original=document.addEventListener;document.addEventListener=function(type,...args){if(['mousemove','mouseup','pointermove','pointerup'].includes(type))count++;return original.call(this,type,...args)};for(let i=0;i<100;i++){renderer.renderAudio('/test.wav');renderer.renderMusic('/test.wav','Title','Artist')}document.addEventListener=original;return count});assert.equal(count,0);
 });
 await t.test('music transport clamps rewind and fast-forward, and stop resets playback',async t=>{
  const p=await fixture(t);await p.evaluate(()=>mount('music'));await p.waitForFunction(()=>audio.readyState>=1);
  await p.getByRole('button',{name:'Rewind 5s'}).click();assert.equal(await p.evaluate(()=>audio.currentTime),0);
  await p.getByRole('button',{name:'Fast Forward 10s'}).click();assert.ok(await p.evaluate(()=>audio.currentTime<=audio.duration));
  await p.getByRole('button',{name:'Play',exact:true}).click();await p.waitForFunction(()=>!audio.paused);
  await p.getByRole('button',{name:'Stop',exact:true}).click();assert.equal(await p.evaluate(()=>audio.paused&&audio.currentTime===0),true);assert.equal(await p.locator('.playing').count(),0);
 });
 await t.test('cancelled pointer scrubbing restores the actual music progress',async t=>{
  const p=await fixture(t);await p.evaluate(()=>mount('music'));await p.waitForFunction(()=>audio.readyState>=1);
  const slider=p.getByRole('slider',{name:'播放进度'});const rect=await slider.boundingBox();await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.down();
  await slider.dispatchEvent('pointercancel',{pointerId:1});await p.mouse.up();assert.equal(await p.evaluate(()=>audio.currentTime),0);assert.equal(await slider.getAttribute('aria-valuenow'),'0');
 });
 await t.test('external volume changes keep the visible fader and spoken value in sync',async t=>{
  const p=await fixture(t);await p.evaluate(()=>{mount('music');audio.volume=0.3});await p.waitForFunction(()=>document.querySelector('.sekai-fader-track').getAttribute('aria-valuenow')==='30');assert.equal(await p.locator('.sekai-fader-cap').evaluate(el=>parseFloat(el.style.top)),70);
 });
 await t.test('code expansion updates its accessible name and expanded state',async t=>{
  const p=await fixture(t);await p.evaluate(()=>document.querySelector('#test').append(renderer.renderCodeV2({lang:'js',collapse:'true'},'<script>literal</script>')));
  const button=p.getByRole('button',{name:'Expand code'});assert.equal(await button.getAttribute('aria-expanded'),'false');await button.click();
  const collapse=p.getByRole('button',{name:'Collapse code'});assert.equal(await collapse.getAttribute('aria-expanded'),'true');await collapse.press('Enter');
  assert.equal(await button.getAttribute('aria-expanded'),'false');assert.equal(await p.locator('script').count(),sources.length);assert.equal(await p.locator('code').textContent(),'<script>literal</script>');
 });
});
