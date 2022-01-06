const debug = require('debug')('lib:modern-smp');
const fs = require('fs').promises;
const _ = require('lodash');
const Queue = require('better-queue');
const { file: tmpFile } = require('tmp-promise');
const { execConsole } = require('./node-tools');
const StakingManagementPolicy = require('./smp');
// const abiElector = require('../contracts/solidity/elector/Elector.abi.json')

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

const reKey = /^[0-9A-Fa-f]{64}$/;

class ModernStakingManagementPolicy extends StakingManagementPolicy {
    constructor(client, ...args) {
        super(client, ...args);

        this.client = client;
        /*
        this.runTVMQueue = new Queue((params, cb) => {
            this.client.tvm.run_tvm(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
        */
        this.runGetQueue = new Queue((params, cb) => {
            this.client.tvm.run_get(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    /*
    runTVM(params) {
        return new Promise((resolve, reject) => {
            this.runTVMQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    async callElectorMethod(call_set) {
        const { message } = await this.client.abi.encode_message({
            abi: {
                type: 'Contract',
                value: abiElector
            },
            address: await super.getElectorAddr(),
            call_set,
            is_internal: false,
            signer: { type: 'None' }
        });
        const result = await this.runTVM({
            abi: {
                type: 'Contract',
                value: abiElector
            },
            account: await super.getElectorBOC(),
            message
        });

        return _.get(result, 'decoded.output.value0');
    }

    async getActiveElectionId() {
        const result = await this.callElectorMethod({
            function_name: 'active_election_id',
            input: {}
        });

        if (_.isNil(result)) {
            throw new Error('getActiveElectionId: failed to get the value');
        }

        return parseInt(result);
    }

    async computeReturnedStake(accountId) {
        const result = await this.callElectorMethod({
            function_name: 'compute_returned_stake',
            input: {
                wallet_addr: `0x${accountId}`
            }
        });

        if (_.isNil(result)) {
            throw new Error('computeReturnedStake: failed to get the value');
        }

        return parseInt(result);
    }
    */

    runGet(params) {
        return new Promise((resolve, reject) => {
            this.runGetQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    async getActiveElectionId() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'active_election_id'
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to get active election id');
        }

        return parseInt(value);
    }

    async getPastElectionIds() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'past_election_ids'
        });

        return _
            .chain(result)
            .get('output.0')
            .map(_.unary(parseInt))
            .filter(_.isNumber)
            .value();
    }

    async computeReturnedStake(accountId) {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'compute_returned_stake',
            input: [`0x${accountId}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to compute returned stake');
        }

        return parseInt(value);
    }

    async participatesIn(publicKey) {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'participates_in',
            input: [`0x${publicKey}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to check if the key participates in current elections');
        }

        return parseInt(value);
    }

    async getNewKeyPair() {
        const { stdout } = await execConsole('newkey');
        const key = _.get(stdout.match(/key hash: (?<key>[0-9A-Fa-f]{64})/), 'groups.key');

        return {
            key,
            secret: null // TODO: find a way to have this secret
        }
    }

    async addKeysAndValidatorAddr(electionStart, validationPeriod, electionKey, electionADNLKey) {
        const requirement = [
            _.isInteger(electionStart), electionStart > 0,
            reKey.test(electionKey),
            reKey.test(electionADNLKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`addKeysAndValidatorAddr: invalid argument(s) detected ${JSON.stringify({
                electionStart,
                electionStop,
                electionKey,
                electionADNLKey
            }, replacer, 2)}`);
        }

        const electionStop = electionStart + validationPeriod;

        await execConsole(
            `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
            `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
            `addadnl ${electionADNLKey} "0"`,
            `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`);
    }

    async exportPub(electionKey) {
        const requirement = [
            reKey.test(electionKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`exportPub: invalid argument(s) detected ${JSON.stringify({
                electionKey
            }, replacer, 2)}`);
        }

        const { stdout } = await execConsole(`exportpub ${electionKey}`);

        return _.get(stdout.match(/imported key: (?<key>[0-9A-Fa-f]{64})/), 'groups.key');
    }

    async signRequest(electionKey, request) {
        const requirement = [
            reKey.test(electionKey),
            !_.isEmpty(request)
        ];

        if (! _.every(requirement)) {
            throw new Error(`signRequest: invalid argument(s) detected ${JSON.stringify({
                electionKey,
                request
            }, replacer, 2)}`);
        }

        const { stdout } = await execConsole(`sign ${electionKey} ${request}`);

        return _.get(stdout.match(/got signature: (?<signature>[0-9A-Fa-f]{128})/), 'groups.signature');
    }

    /*
    async getParticipantListExtended() {
        // TODO: currently accessible Elector ABI doesn't provide a function for that - wait

        return {
            totalStake: 0
        }
    }
    */

    async getParticipantListExtended() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'participant_list_extended'
        });
        const [electAt, electClose, minStake, totalStake, l, failed, finished] = _.get(result, 'output', []);
        const parseList = list => {
            if (_.isNil(list)) {
                return [];
            }

            const [[id, [stake, maxFactor, addr, adnlAddr]], tail] = list;
            const head = {
                id,
                stake: parseInt(stake),
                maxFactor: parseInt(maxFactor),
                addr,
                adnlAddr
            }

            return [head, ...parseList(tail)];
        }

        return {
            electAt: parseInt(electAt),
            electClose: parseInt(electClose),
            minStake: parseInt(minStake),
            totalStake: parseInt(totalStake),
            participants: parseList(l),
            failed: parseInt(failed),
            finished: parseInt(finished)
        };
    }

    async sendMessageViaConsole(message_encode_params) {
        const { message } = await this.client.abi.encode_message(message_encode_params);
        const { path, cleanup } = await tmpFile({ postfix: 'msg-body.boc' });

        await fs.writeFile(path, message, 'base64');

        const { stdout, stderr } = await execConsole(`sendmessage ${path}`);

        cleanup();

        const success = /success/.test(stdout);

        if (!success) {
            debug(stdout);
            debug(stderr);
        }

        return _.set({}, 'transaction.action.success', success);
    }

    async getAccountStateViaConsole(address) {
        const { path, cleanup } = await tmpFile({ postfix: 'account-state.boc' });

        try {
            const { stdout } = await execConsole(`getaccountstate ${address} ${path}`);

            if (_.startsWith(stdout, 'Error')) {
                const msg = _.get(stdout.match(/ErrorMessage { msg: "(?<msg>.*)" }/), 'groups.msg');

                throw new Error(msg);
            }

            return fs.readFile(path, 'base64');
        }
        finally {
            cleanup();
        }
    }

    async getAccountViaConsole(address) {
        const { stdout } = await execConsole(`getaccount ${address}`);
        const account = JSON.parse(stdout);

        if (account.acc_type === 'Nonexist') {
            throw new Error('account doesn\'t exist');
        }

        return account;
    }

    async getConfigViaConsole(n) {
        const { stdout } = await execConsole(`getconfig ${n}`);
        const config = JSON.parse(stdout);

        return config[`p${n}`];
    }

    async getTimeDiff() {
        const { stdout } = await execConsole('getstats');
        const stats = JSON.parse(stdout);

        if (_.isNaN(stats.timediff)) {
            throw new Error('getTimeDiff: failed to get the value');
        }

        return -stats.timediff;
    }

    async restoreKeysImpl({ id, key, adnlKey, secrets }) {
        throw new Error('unsupported by this policy');
    }
}

module.exports = ModernStakingManagementPolicy;
