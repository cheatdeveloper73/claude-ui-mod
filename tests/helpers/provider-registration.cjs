'use strict';
// Declares a provider the way a provider plugin's provider.json does, so these
// tests exercise the registration path in a tree that ships no such plugin.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-registrations-'));
fs.mkdirSync(path.join(dir, 'web-relay'));
fs.writeFileSync(path.join(dir, 'web-relay', 'provider.json'), JSON.stringify({
    version: 1, provider: 'web-relay', label: 'Web Relay', idPattern: '^relay-[a-z0-9._-]{1,80}$',
    modelsFile: '.state/web-relay/models.json', modelsFileEnv: 'CUIMOD_TEST_RELAY_MODELS',
}));
process.env.CUIMOD_PROVIDER_REGISTRATIONS = dir;

// A deployment's helper and routed subagent tier, as defaults.private.json
// would name them.
const defaults = path.join(dir, 'routing-defaults.json');
fs.writeFileSync(defaults, JSON.stringify({ helperModel: 'claude-helper-flash[1m]', routedSubagentModel: 'routed-flash' }));
process.env.CUIMOD_ROUTING_DEFAULTS = defaults;

module.exports = { dir };
