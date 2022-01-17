import * as fs from 'fs';
import util from 'util';
import _ from 'lodash';
import { exec as Exec } from 'child_process';
import { console } from '../config.js';

const exec = util.promisify(Exec);
const execOpts = {
    timeout: 60000,
    killSignal: 'SIGKILL'
};

export function execConsole(...commands) {
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

export function execKeyGen() {
    return exec('keygen', execOpts);
}
