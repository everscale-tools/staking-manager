import * as fs from 'fs';
import util from 'util';
import _ from 'lodash';
import { exec as Exec } from 'child_process';

const exec = util.promisify(Exec);
const execOpts = {
    timeout: 60000,
    killSignal: 'SIGKILL'
};

export function execConsole(opts, ...commands) {
    const requirement = [
        _.chain(opts).get('client.privateKey').isString().value(),
        _.chain(opts).get('server.host').isString().value(),
        _.chain(opts).get('server.port').isInteger().value(),
        _.chain(opts).get('server.publicKey').isString().value()
    ];

    if (! _.every(requirement)) {
        throw new Error(`execConsole: wrong console configuration: ${JSON.stringify(opts, null, 2)}`);
    }

    const configFile = 'console.json';

    if (! fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, JSON.stringify({
            config: {
                client_key: {
                    type_id: 1209251014,
                    pvt_key: opts.client.privateKey
                },
                server_address: `${opts.server.host}:${opts.server.port}`,
                server_key: {
                    type_id: 1209251014,
                    pub_key: opts.server.publicKey
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
