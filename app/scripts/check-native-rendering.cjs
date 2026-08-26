const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app/src-tauri/src/main.rs'), 'utf8').replace(/\r\n/g, '\n');
const repaintCalls = source.match(/request_repaint_after/g) || [];

if (source.includes('request_repaint_after(std::time::Duration::from_millis(100))')) {
  throw new Error('native client still requests an unconditional 100ms repaint');
}
if (repaintCalls.length !== 1) {
  throw new Error('native client must keep a single conditional repaint request');
}

const expected = 'if self.task.is_some() {\n            ctx.request_repaint_after(std::time::Duration::from_millis(ASYNC_TASK_POLL_MS));\n        }';
if (!source.includes(expected)) {
  throw new Error('native async repaint must remain conditional on an active task');
}

console.log('native rendering policy checks passed');
