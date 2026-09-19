/**
 * Reads `./.env` into process.env before anything else reads it.
 *
 * index.ts imports this first for that reason: the logger, for one, settles
 * its level and whether to write a file while it is being imported. A
 * variable already set in the environment wins over the file, and having no
 * file at all is the ordinary case.
 */
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
