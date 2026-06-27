const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf-8');

// Print each line to find the syntax error
const lines = code.split('\n');
for (let i = 0; i < lines.length; i++) {
  try {
    new Function(lines[i]);
  } catch(e) {
    if (!lines[i].trim().startsWith('import ') && 
        !lines[i].trim().startsWith('export ') &&
        lines[i].trim().length > 0) {
      console.log('ERR at line', i+1, ':', e.message);
      console.log('  content:', lines[i].substring(0, 100));
    }
  }
}
console.log('Line-by-line check done');
