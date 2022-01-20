import assert from 'assert/strict';
import { readFile } from 'fs/promises';
// import crypto from 'crypto';
import _ from 'lodash';
import Debug from 'debug';
import Async from 'async';
import mem from 'mem';
import got from 'got';
import { execConsole } from './node-tools.js';

const abiWallet = await loadJSON('./contracts/solidity/safemultisig/SafeMultisigWallet.abi.json');
const debug = Debug('lib:smp');
const reKey = /^[0-9A-Fa-f]{64}$/;

export default class StakingManagementPolicy {
    constructor(client, datastore, config) {
        this.client = client;
        this.datastore = datastore;
        this.wallet = config.wallet;
        this.funding = config.funding;
        this.webhooks = config.webhooks;
        this.participationConfirmationTimeout = _.get(config, 'participationConfirmationTimeout', 3600);
        this.stakeSendingIsInProgress = false;
        this.getConfigParamMemoized = mem(_.bind(this.getConfigParamImpl, this));
    }

    getConfigParam(id) {
        const freshOnly = _.some([34, 36], _.partial(_.eq, id));

        return freshOnly ? this.getConfigParamImpl(id) : this.getConfigParamMemoized(id);
    }

    getAccountState(address) {
        return this.getAccountStateImpl(address);
    }

    submitTransaction(input, retryAttempts = 5) {
        const retryOpts = {
            times: retryAttempts,
            interval: count => 1000 * Math.pow(2, count - 1) // 1s, 2s, 4s ...
        };
        const task = cb => {
            const params = {
                abi: {
                    type: 'Contract',
                    value: abiWallet
                },
                address: this.wallet.addr,
                call_set: {
                    function_name: 'submitTransaction',
                    input,
                },
                is_internal: false,
                signer: {
                    type: 'Keys',
                    keys: this.wallet.keys
                }
            };

            this.submitTransactionImpl(params)
                .then(_.partial(cb, null))
                .catch(cb);
        };

        return Async.retry(retryOpts, task);
    }

    async sendStakeImpl(electionId, srcAddr, dstAddr, stake, incStake, maxFactor, retryAttempts) {
        assert(/-1:[0-9A-Fa-f]{64}/.test(srcAddr));
        assert(/(-1|0):[0-9A-Fa-f]{64}/.test(dstAddr));
        assert(_.isInteger(stake) && stake > 0);
        assert(_.isBoolean(incStake));
        assert(maxFactor >= 1 && maxFactor <= 100);
        assert(_.isInteger(retryAttempts) && retryAttempts > 0);

        const dbEntry = await this.datastore.getElectionsInfo(electionId);

        try {
            if (! _.every(['key', 'adnlKey'], _.partial(_.has, dbEntry))) {
                const { key, secret } = await this.getNewKeyPair();
                const publicKey = await this.exportPub(key);
                const { key: adnlKey, secret: adnlSecret } = await this.getNewKeyPair();
                const validationPeriod = _
                    .chain(await this.getConfigParam(15))
                    .get('validators_elected_for')
                    .defaultTo(65536)
                    .value();

                await this.addKeysAndValidatorAddr(electionId, validationPeriod, key, adnlKey);

                dbEntry.key = key;
                dbEntry.publicKey = publicKey;
                dbEntry.adnlKey = adnlKey;
                dbEntry.secrets = [secret, adnlSecret];
            }

            // validator-elect-req.fif
            const buffers = [
                Buffer.alloc(4),
                Buffer.alloc(4),
                Buffer.alloc(4),
                Buffer.from(_.chain(srcAddr).split(':').nth(1).value(), 'hex'),
                Buffer.from(dbEntry.adnlKey, 'hex')
            ];

            buffers[0].writeUInt32BE(0x654C5074);
            buffers[1].writeUInt32BE(dbEntry.id);
            buffers[2].writeUInt32BE(maxFactor * 65536.0);

            const request = Buffer.concat(buffers).toString('hex');

            dbEntry.signature = await this.signRequest(dbEntry.key, request);

            /*
            const ok = crypto.verify(
                'ed25519',
                Buffer.from(request, 'hex'),
                Buffer.from(dbEntry.key, 'hex'),
                Buffer.from(dbEntry.signature, 'hex'));

            debug(`INFO: signature verified: ${ok}`);
            */

            // validator-elect-signed.fif
            const writeInteger = (value, size) => ({ type: 'Integer', size, value });
            const writeBitString = (value) => ({ type: 'BitString', value });
            const { boc: payload } = await this.client.boc.encode_boc({
                builder: [
                    writeInteger(0x4E73744B, 32),
                    writeInteger(Math.floor(Date.now() / 1000), 64),
                    writeBitString(dbEntry.publicKey),
                    writeInteger(dbEntry.id, 32),
                    writeInteger(_.round(maxFactor * 65536.0), 32),
                    writeInteger(`0x${dbEntry.adnlKey}`, 256),
                    { type: 'Cell', builder: [writeBitString(dbEntry.signature)] }
                ]
            });

            await this.submitTransaction({
                dest: dstAddr,
                value: stake * 1000000000,
                bounce: true,
                allBalance: false,
                payload
            }, retryAttempts);

            dbEntry.lastStakeSendingTime = Math.floor(Date.now() / 1000);

            debug('INFO: stake sending transaction has been submitted');
        }
        finally {
            await this.datastore.setElectionsInfo(dbEntry, incStake);
        }
    }

    async sendStake(maxFactor = 3, retryAttempts = 5) {
        const activeElectionId = await this.getActiveElectionId();

        if (activeElectionId === 0) {
            debug('INFO: no current elections');

            await this.performOutOfElectionsAction();

            return;
        }

        debug(`INFO: elections ${activeElectionId}`);

        if (this.stakeSendingIsInProgress) {
            debug('INFO: stake sending is already in progress...');

            return;
        }

        const dbEntry = await this.datastore.getElectionsInfo(activeElectionId);
        const publicKey = _.get(dbEntry, 'publicKey');

        if (publicKey) {
            const participationConfirmed = _.get(dbEntry, 'participationConfirmed', false);

            if (participationConfirmed) {
                debug(`INFO: already participating: pubkey=0x${publicKey}, stake=${dbEntry.stake}`);

                return;
            }
            else {
                const stake = await this.participatesIn(publicKey);

                if (stake > 0) {
                    dbEntry.participationConfirmed = true;
                    dbEntry.stake = stake;

                    await this.datastore.setElectionsInfo(dbEntry);

                    await this.callWebhook({
                        subject: 'PARTICIPATION_CONFIRMED',
                        context: `https://ton.live/validators/validatorDetails?publicKey=${dbEntry.publicKey}`
                    });

                    debug(`INFO: already participating: pubkey=0x${publicKey}, stake=${dbEntry.stake}`);

                    return;
                }
                else {
                    const lastStakeSendingTime = _.get(dbEntry, 'lastStakeSendingTime');

                    if (lastStakeSendingTime) {
                        const now = Math.floor(Date.now() / 1000);
                        const elapsed = now - lastStakeSendingTime;

                        if (elapsed >= this.participationConfirmationTimeout) {
                            await this.callWebhook({
                                subject: 'PARTICIPATION_NOT_CONFIRMED',
                                context: elapsed
                            });

                            debug(`WARN: participation hasn't been confirmed since ${lastStakeSendingTime} (for ${elapsed} seconds) - stake sending will be retried`);
                        }
                        else {
                            debug(`INFO: still waiting for participation confirmation since ${lastStakeSendingTime} (for ${elapsed} seconds)...`);

                            return;
                        }
                    }
                }
            }
        }

        if (await this.datastore.skipNextElections()) {
            debug('INFO: these elections are configured to be skipped');

            return;
        }

        this.stakeSendingIsInProgress = true;

        try {
            await this.sendStakeImplDecorator(activeElectionId, maxFactor, retryAttempts);
        }
        catch (err) {
            await this.callWebhook({
                subject: 'STAKE_SENDING_FAILED',
                context: _.get(err, 'message', 'N/A')
            });

            throw err;
        }
        finally {
            this.stakeSendingIsInProgress = false;
        }
    }

    async restoreKeys() {
        const ids = await this.getPastElectionIds();
        const activeElectionId = await this.getActiveElectionId();

        if (activeElectionId !== 0) {
            ids.push(activeElectionId);
        }

        debug('ids', ids);

        for (const id of ids) {
            const info = await this.datastore.getElectionsInfo(id);

            debug('info', JSON.stringify(info, null, 2));

            if (! _.every(['key', 'adnlKey', 'secrets'], _.partial(_.has, info))) {
                throw new Error('"key", "adnlKey" and "secrets" must be provided');
            }

            this.restoreKeysImpl(info);
        }
    }

    async restoreKeysImpl(/* { id, key, adnlKey, secrets } */) {
        throw new Error('unsupported by this policy');
    }

    async callWebhook(json) {
        const options = _.get(this.webhooks, 'options');

        if (_.isPlainObject(options)) {
            try {
                await got({ ...options, json });
            }
            catch (err) {
                debug(`WARN: webhook failed with error ${_.toString(err)}`);
            }
        }
    }

    async getNewKeyPair() {
        const { stdout } = await execConsole('newkey');
        const key = _.get(stdout.match(/key hash: (?<key>[0-9A-Fa-f]{64})/), 'groups.key');

        return {
            key,
            secret: null // TODO: find a way to have this secret
        };
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

    skipNextElections(skip) {
        return this.datastore.skipNextElections(skip);
    }

    async getTimeDiff() {
        const { stdout } = await execConsole('getstats');
        const stats = JSON.parse(stdout);

        if (_.isNaN(stats.timediff)) {
            throw new Error('getTimeDiff: failed to get the value');
        }

        return -stats.timediff;
    }
}

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

async function loadJSON(path) {
    return JSON.parse(await readFile(path));
}

