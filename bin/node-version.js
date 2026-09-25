/**
 * Whether this Node can run the server.
 *
 * Mission Control keeps its own state in `node:sqlite`, which arrived in 22.5
 * behind --experimental-sqlite and loads without the flag only from 22.13 and
 * 23.4. The two release lines dropped the flag separately, so 23.0 to 23.3 are
 * newer than 22.13 and still cannot load it. On any of those the server's first
 * import fails with ERR_UNKNOWN_BUILTIN_MODULE, which names a module rather
 * than the fix, and `engines` in package.json does not stop it: npm only warns.
 *
 * @param {string} version `process.versions.node`, such as `22.13.0`
 * @returns {boolean}
 */
export function supportsNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}
