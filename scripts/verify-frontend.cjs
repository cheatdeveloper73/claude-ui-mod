'use strict';

const { verifyBundle, BUNDLE_DIR } = require('../lib/frontend-assets');
const result = verifyBundle(process.argv[2] || BUNDLE_DIR);
console.log(JSON.stringify(result, null, 2));
if (result.problems.length) process.exitCode = 1;
