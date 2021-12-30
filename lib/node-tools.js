'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const exec = util.promisify(require('child_process').exec);
const { console } = require('../config')

const execOpts = {
    timeout: 60000,
    killSignal: 'SIGKILL'
}

function execConsole(...commands) {
    const requirement = [
        _.chain(console).get('client.privateKey').isString().value(),
        _.chain(console).get('server.host').isString().value(),
        _.chain(console).get('server.port').isInteger().value(),
        _.chain(console).get('server.publicKey').isString().value()
    ];

    if (! _.every(requirement)) {
        throw new Error('execConsole: wrong console configuration');
    }

    const configFile = 'console.json';

    if (! fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, JSON.stringify({
            config: {
                client_key: {
                    type_id: 1209251014,
                    pvt_key: console.client.privateKey
                },
                server_address: `${console.server.host}:${console.server.port}`,
                server_key: {
                    type_id: 1209251014,
                    pub_key: console.server.publicKey
                },
                timeouts: null
            }
        }));
    }

    return exec(
        `console -j -C ${configFile} \
            ${[...commands].map(c => `-c '${c}'`).join(' ')}`,
        execOpts);
}

function execKeyGen() {
    return exec('keygen', execOpts);
}

module.exports = {
    execConsole,
    execKeyGen
}
