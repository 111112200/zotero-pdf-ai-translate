import fs from 'node:fs';
const pages=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const cache=JSON.parse(fs.readFileSync(process.argv[3],'utf8')).entries;
function hash128(input){return [0x811c9dc5,0x01000193,0x7fffffff,0x9e3779b9].map(seed=>{let hash=seed>>>0;for(let i=0;i<input.length;i++){hash^=input.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}return hash.toString(16).padStart(8,'0');}).join('');}
const bySource=new Map(Object.entries(cache).map(([key,value])=>[key.split(':')[1],value]));
let hit=0,miss=0;const translations={};
for(const page of pages)page.paragraphs.forEach((paragraph,index)=>{if(paragraph.isFormulaBlock)return;const value=bySource.get(hash128(paragraph.source));if(value!==undefined){translations[`${page.index}:${index}`]=value;hit++;}else miss++;});
fs.writeFileSync(process.argv[4],JSON.stringify(translations));console.log({hit,miss});
