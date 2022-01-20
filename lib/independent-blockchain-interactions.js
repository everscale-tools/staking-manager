import { readFile, writeFile } from 'fs/promises';
import _ from 'lodash';
import Debug from 'debug';
import { file as tmpFile } from 'tmp-promise';
import { execConsole } from './node-tools.js';

const debug = Debug('lib:independent-blockchain-interactions');

export default (superclass) => class extends superclass {
    constructor(client, datastore, config) {
        super(client, datastore, config);

        this.client = client;
    }

    async submitTransactionImpl(message_encode_params) {
        const { message } = await this.client.abi.encode_message(message_encode_params);
        const { path, cleanup } = await tmpFile({ postfix: 'msg-body.boc' });

        await writeFile(path, message, 'base64');

        const { stdout, stderr } = await execConsole(`sendmessage ${path}`);

        cleanup();

        const success = /success/.test(stdout);

        if (!success) {
            debug(stdout);
            debug(stderr);

            throw new Error('sendmessage failed');
        }
    }

    async getConfigParamImpl(id) {
        const { stdout } = await execConsole(`getconfig ${id}`);
        const config = JSON.parse(stdout);

        return config[`p${id}`];
    }

    async getAccountStateImpl(address) {
        const { path, cleanup } = await tmpFile({ postfix: 'account-state.boc' });

        try {
            const { stdout } = await execConsole(`getaccountstate ${address} ${path}`);

            if (_.startsWith(stdout, 'Error')) {
                const msg = _.get(stdout.match(/ErrorMessage { msg: "(?<msg>.*)" }/), 'groups.msg');

                throw new Error(msg);
            }

            return readFile(path, 'base64');
        }
        finally {
            cleanup();
        }
    }

    async getAccountBalance(address) {
        const { stdout } = await execConsole(`getaccount ${address}`);
        const account = JSON.parse(stdout);

        if (account.acc_type === 'Nonexist') {
            throw new Error('account doesn\'t exist');
        }

        return account.balance;
    }
};

