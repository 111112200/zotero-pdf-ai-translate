import fs from 'node:fs';import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
for(const file of process.argv.slice(2)){
 for(let run=0;run<2;run++){
  const started=performance.now();const doc=await pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(file)),disableFontFace:true}).promise;const loaded=performance.now();let operators=0,items=0;
  for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const list=await page.getOperatorList();operators+=list.fnArray.length;items+=(await page.getTextContent()).items.length;page.cleanup();}
  const ended=performance.now();await doc.destroy();console.log(JSON.stringify({file,run,loadMs:Math.round(loaded-started),allPagesMs:Math.round(ended-started),operators,items}));
 }
}
