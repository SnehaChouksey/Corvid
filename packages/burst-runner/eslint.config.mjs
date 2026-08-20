import base from '@corvid/eslint-config/base';

// build.mjs is a Node build script (esbuild driver), not product code — exclude it from the
// product lint rules (no-console/no-undef); dist holds the generated bundle.
export default [...base, { ignores: ['dist', 'build.mjs'] }];
