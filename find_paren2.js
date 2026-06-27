const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf-8');

let parens = 0;
let inString = false, stringChar = '';
let inTemplate = false;
let inSingleComment = false;
let inMultiComment = false;
let line = 1;

const lines = code.split('\n');
for (let l = 0; l < lines.length; l++) {
  const text = lines[l];
  let prevParens = parens;
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i+1] : '';
    
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
    
    if (ch === '(') parens++;
    if (ch === ')') parens--;
  }
  
  // Check for function definitions that might be missing a closing paren
  // Report lines at depth 0 where we see a function that starts
  if (prevParens === parens && parens > 0) {
    // line has net 0 parens change but we're still inside a paren group
  }
}

// Rewind: find where the last unclosed paren was opened
parens = 0;
let lastOpenLine = 0;
let lastOpenCol = 0;
for (let l = 0; l < lines.length; l++) {
  const text = lines[l];
  // Reset all state tracking for a simpler scan
  // Just count raw parens in non-comment, non-string code
  const stripped = text.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
  
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '(') {
      parens++;
      lastOpenLine = l + 1;
    }
    if (stripped[i] === ')') {
      parens--;
      if (parens < 0) {
        console.log('Extra ) at line', l+1, 'col', i);
        parens = 0;
      }
    }
  }
}
console.log('Final depth (simple scan):', parens);
if (parens > 0) console.log('Unclosed ( opened at around line', lastOpenLine);
