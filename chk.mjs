import { readFileSync } from 'fs';
const html = readFileSync('client/index.html','utf8');
const start = html.indexOf('<script>');
const end = html.lastIndexOf('</script>');
const script = html.slice(start+8, end);
try {
  // Use dynamic import trick to check syntax
  const blob = new Blob([script], { type: 'text/javascript' });
  // Use Node's built-in parse
  const { parse } = await import('acorn');
  parse(script, { ecmaVersion: 2022, sourceType: 'script' });
  console.log('CLIENT SYNTAX OK');
} catch(e) {
  console.log('CLIENT ERROR:', e.message);
  // show context
  const lines = script.split('\n');
  if (e.loc) {
    const ln = e.loc.line;
    for (let i = Math.max(0, ln-4); i < Math.min(lines.length, ln+3); i++) {
      console.log(`${i+1}${i+1===ln?' <<':'   '} | ${lines[i]}`);
    }
  }
}
