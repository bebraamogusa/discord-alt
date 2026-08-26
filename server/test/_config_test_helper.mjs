import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.DOTENV_CONFIG_PATH = join(__dirname, '.env.test.empty');

try {
  const configUrl = pathToFileURL(join(__dirname, '..', 'config.js')).href;
  const mod = await import(configUrl);
  console.log(JSON.stringify(mod.config));
} catch (e) {
  console.error('ERROR:' + e.message);
  process.exit(1);
}
