const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf-8');

let parens = 0;
let inString = false, stringChar = '';
let inTemplate = false;
let inSingleComment = false;
let inMultiComment = false;
let minParens = 0;
let minLine = 0;
let line = 1;

for (let i = 0; i < code.length; i++) {
  const ch = code[i];
  const next = i + 1 < code.length ? code[i+1] : '';
  
  if (ch === '\n') line++;
  
  if (inMultiComment) {
    if (ch === '*' && next === '/') { inMultiComment = false; i++; }
    continue;
  }
  if (inSingleComment) {
    if (ch === '\n') inSingleComment = false;
    continue;
  }
  if (ch === '/' && next === '/') { inSingleComment = true; i++; continue; }
  if (ch === '/' && next === '*') { inMultiComment = true; i++; continue; }
  
  if (inTemplate) {
    if (ch === '`') inTemplate = false;
    continue;
  }
  if (inString) {
    if (ch === '\\') { i++; continue; }
    if (ch === stringChar) inString = false;
    continue;
  }
  
  if (ch === '`') { inTemplate = true; continue; }
  if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
  
  if (ch === '(') {
    parens++;
  }
  if (ch === ')') {
    parens--;
    if (parens < minParens) {
      minParens = parens;
      minLine = line;
    }
  }
}

console.log('Final parens:', parens);
console.log('Min parens depth:', minParens, 'at line', minLine);

// Now find unbalanced paren by checking if a line has just ')' with nothing else
const lines = code.split('\n');
for (let l = 0; l < lines.length; l++) {
  const trimmed = lines[l].trim();
  // Look for regex literal patterns that might confuse the parser
  if (trimmed.match(/^\s*\}\s*\)\s*$/)) {
    console.log('Possible lone close paren at line', l+1, ':', trimmed);
  }
}
