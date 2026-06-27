const fs = require('fs');

// Try to parse the file as JavaScript
// Since Node can't do ES module parsing directly, we'll use a workaround
const code = fs.readFileSync('public/app.js', 'utf-8');

// Remove the import lines (they use module syntax that Node can't eval)
const strippedCode = code.replace(/^import .*$/gm, '// removed import');

try {
  new Function(strippedCode);
  console.log('PARSED OK via Function()');
} catch(e) {
  console.log('PARSE ERROR:', e.message);
  // Try to find the line
  const match = e.stack?.match(/:(\d+):(\d+)/);
  if (match) {
    console.log('  at line', match[1], 'col', match[2]);
    const errLine = parseInt(match[1]);
    const lines = code.split('\n');
    for (let i = Math.max(0, errLine - 3); i < Math.min(lines.length, errLine + 2); i++) {
      console.log((i+1) + ': ' + lines[i]);
    }
  }
}
