const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf-8');

// Try a simple approach: strip all comments and template literals, 
// then check for basic structural issues by looking at brace/paren depth
// at the END of each line, to find where the structure goes wrong

let lineDepth = 0;
const lines = code.split('\n');

// Track the net contribution of each line to paren depth
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  // Remove string contents and comments for counting
  let clean = raw.replace(/\/\/.*$/, '') // single-line comment
                 .replace(/\/\*[\s\S]*?\*\//g, '') // multi-line comment
                 .replace(/`[^`]*`/g, '``') // template literal
                 .replace(/'[^']*'/g, "''") // single-quoted string
                 .replace(/"[^"]*"/g, '""'); // double-quoted string
  
  // Count parens
  let prevDepth = lineDepth;
  for (const ch of clean) {
    if (ch === '(') lineDepth++;
    if (ch === ')') lineDepth--;
  }
  
  // Report lines where depth drops below 0
  if (lineDepth < 0 && prevDepth >= 0) {
    console.log(`Line ${i+1}: DEPTH DROP to ${lineDepth} (extra closing paren)`);
    console.log(`  ${raw.substring(0, 100)}`);
  }
}

console.log(`\nFinal paren depth: ${lineDepth}`);
// Back to start, show lines that OPEN parens at depth 0
lineDepth = 0;
const openAtDepth = [];
for (let i = 0; i < lines.length; i++) {
  const clean = lines[i].replace(/\/\/.*$/, '').replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const opens = (clean.match(/\(/g) || []).length;
  const closes = (clean.match(/\)/g) || []).length;
  const net = opens - closes;
  if (net > 0 && lineDepth === 0) {
    openAtDepth.push({line: i+1, text: lines[i].substring(0, 80)});
  }
  lineDepth += net;
  if (lineDepth < 0) lineDepth = 0;
}

// Show the last few opens (these are likely the unclosed ones)
console.log('\nLast opens at depth 0 (potential unclosed parens):');
openAtDepth.slice(-10).forEach(o => console.log(`  Line ${o.line}: ${o.text}`));
