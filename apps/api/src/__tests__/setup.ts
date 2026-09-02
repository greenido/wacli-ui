import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point every on-disk singleton at a throwaway directory before the modules that
 * read them are imported. Without this the suite loads — and `setReadOnly`
 * rewrites — the developer's real ~/.wacli-mission-control/settings.json.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-test-'));

process.env.WACLI_SETTINGS_FILE = path.join(sandbox, 'settings.json');
process.env.WACLI_SCHEDULED_FILE = path.join(sandbox, 'scheduled.json');
process.env.WACLI_BOOKMARKS_FILE = path.join(sandbox, 'bookmarks.json');
process.env.WACLI_STORE_DIR = path.join(sandbox, 'store');
process.env.WACLI_LOG_DIR = path.join(sandbox, 'logs');

fs.mkdirSync(path.join(sandbox, 'store', 'media'), { recursive: true });

/** Media fixtures must live inside the store to pass path containment. */
export const TEST_STORE_DIR = path.join(sandbox, 'store');
export const TEST_MEDIA_DIR = path.join(sandbox, 'store', 'media');
