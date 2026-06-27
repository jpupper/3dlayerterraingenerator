const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf-8');

let braces = 0, parens = 0, brackets = 0;
let inString = false, stringChar = '';
let inTemplate = false;
let inSingleComment = false;
let inMultiComment = false;

for (let i = 0; i < code.length; i++) {
  const ch = code[i];
  const next = i + 1 < code.length ? code[i+1] : '';
  
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
    else if (ch === '$' && next === '{') { /* template expr - skip */ }
    continue;
  }
  if (inString) {
    if (ch === '\\') { i++; continue; } // skip escaped char
    if (ch === stringChar) inString = false;
    continue;
  }
  
  if (ch === '`') { inTemplate = true; continue; }
  if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
  
  if (ch === '{') braces++;
  if (ch === '}') braces--;
  if (ch === '(') parens++;
  if (ch === ')') parens--;
  if (ch === '[') brackets++;
  if (ch === ']') brackets--;
}

console.log('Braces:', braces, 'Parens:', parens, 'Brackets:', brackets);
if (braces !== 0) console.log('ERROR: UNBALANCED BRACES!');
if (parens !== 0) console.log('ERROR: UNBALANCED PARENS!');
if (brackets !== 0) console.log('ERROR: UNBALANCED BRACKETS!');
if (braces === 0 && parens === 0 && brackets === 0) console.log('ALL BALANCED');
