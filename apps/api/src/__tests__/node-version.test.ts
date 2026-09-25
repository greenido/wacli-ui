import { describe, it, expect } from 'vitest';
import { supportsNode } from '../../../../bin/node-version.js';

/**
 * `engines` used to say >=22.5.0, where `node:sqlite` exists only behind
 * --experimental-sqlite: on 22.11 the server died on its first import with
 * ERR_UNKNOWN_BUILTIN_MODULE. The 22 and 23 lines dropped the flag separately,
 * so a plain "newer than" comparison gets the 23 line wrong.
 */
describe('supportsNode', () => {
  it('refuses the releases where node:sqlite still needs a flag', () => {
    for (const version of ['20.18.0', '22.5.0', '22.11.0', '22.12.9', '23.0.0', '23.3.0']) {
      expect(supportsNode(version), version).toBe(false);
    }
  });

  it('accepts the releases that load it as-is', () => {
    for (const version of ['22.13.0', '22.23.2', '23.4.0', '24.0.0', '26.1.0']) {
      expect(supportsNode(version), version).toBe(true);
    }
  });

  it('reads process.version as well as process.versions.node', () => {
    expect(supportsNode('v22.13.0')).toBe(true);
    expect(supportsNode('v22.11.0')).toBe(false);
  });
});
