const { chromium } = require('/tmp/mdbshot/node_modules/playwright');
const url = process.argv[2] || 'http://localhost:8787/';
const out = process.argv[3] || '/workspace/frame-dashboard/live/preview.png';
(async()=>{
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
  const p=await b.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2});
  p.on('console',m=>{if(m.type()==='error')console.log('console:',m.text());});
  await p.goto(url,{waitUntil:'networkidle'});
  await p.waitForTimeout(4000);
  await p.screenshot({path:out});
  await b.close();
})();
