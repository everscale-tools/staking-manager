import assert from 'assert/strict';
import { readFile } from 'fs/promises';
// import crypto from 'crypto';
import _ from 'lodash';
import Debug from 'debug';
import Async from 'async';
import mem from 'mem';
import { execConsole } from './node-tools.js';

const abiWallet = await loadJSON('./contracts/solidity/safemultisig/SafeMultisigWallet.abi.json');
const debug = Debug('lib:smp');
const reKey = /^[0-9A-Fa-f]{64}$/;

export default class StakingManagementPolicy {
    constructor(client, datastore) {
        this.client = client;
        this.datastore = datastore;
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
        const task = async () => {
            const address = await this.datastore.getWalletAddress();
            const keys = await this.datastore.getWalletKeys();
            const params = {
                abi: {
                    type: 'Contract',
                    value: abiWallet
                },
                address,
                call_set: {
                    function_name: 'submitTransaction',
                    input,
                },
                is_internal: false,
                signer: {
                    type: 'Keys',
                    keys,
                }
            };
            const result = await this.submitTransactionImpl(params);

            return result;
        };

        return Async.retry(retryOpts, task);
    }

    async sendStakeImpl(electionId, srcAddr, dstAddr, stake, incStake, maxFactor, retryAttempts) {
        assert(/-1:[0-9A-Fa-f]{64}/.test(srcAddr), `srcAddr fails to validate: ${srcAddr}`);
        assert(/(-1|0):[0-9A-Fa-f]{64}/.test(dstAddr), `dstAddr fails to validate: ${dstAddr}`);
        assert(_.isInteger(stake) && stake > 0, `stake fails to validate: ${stake}`);
        assert(_.isBoolean(incStake), `incStake fails to validate: ${incStake}`);
        assert(maxFactor >= 1 && maxFactor <= 100, `maxFactor fails to validate: ${maxFactor}`);
        assert(_.isInteger(retryAttempts) && retryAttempts > 0, `retryAttempts fails to validate: ${retryAttempts}`);

        const dbEntry = await this.datastore.getElectionsInfo(electionId);

        try {
            if (! _.every(['key', 'adnlKey'], _.partial(_.has, dbEntry))) {
                const { key, secret } = await this.getNewKeyPair();
                const publicKey = await this.exportPub(key);
                const { key: adnlKey, secret: adnlSecret } = await this.getNewKeyPair();
                const validationPeriod = _
                    .chain(await this.getConfigParam(15))
                    .get('validators_elected_for')
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
        if (this.stakeSendingIsInProgress) {
            debug('INFO: stake sending is already in progress...');

            return;
        }

        try {
            const activeElectionId = await this.getActiveElectionId();
            const electionsId = _
                .chain(await this.getPastElectionIds())
                .last()
                .defaultTo(activeElectionId)
                .value();
            const dbEntry = await this.datastore.getElectionsInfo(electionsId);
            const { publicKey } = dbEntry;

            if (publicKey) {
                const participationConfirmed = _.get(dbEntry, 'participationConfirmed', false);

                if (participationConfirmed) {
                    return;
                }

                const stake = await this.participatesIn(publicKey);

                if (stake > 0) {
                    dbEntry.participationConfirmed = true;
                    dbEntry.stake = stake;

                    await this.datastore.setElectionsInfo(dbEntry);

                    debug(`INFO: already participating: pubkey=0x${publicKey}, stake=${stake}`);

                    const {
                        validators_elected_for: validatorsElectedFor,
                        elections_start_before: electionsStartBefore
                    } = await this.getConfigParam(15);

                    _.invoke(this, 'sendNotification', {
                        event: 'PARTICIPATION_CONFIRMED',
                        context: {
                            electionsId,
                            nextElectionsId: electionsId + validatorsElectedFor - electionsStartBefore,
                            publicKey
                        }
                    });

                    return;
                }

                if (activeElectionId === 0) {
                    return;
                }

                const lastStakeSendingTime = _.get(dbEntry, 'lastStakeSendingTime');

                if (lastStakeSendingTime) {
                    const { participationConfirmationTimeout: timeout } = await this.datastore.getSettings();
                    const now = Math.floor(Date.now() / 1000);
                    const elapsed = now - lastStakeSendingTime;

                    if (elapsed < timeout) {
                        debug(`INFO: still waiting for participation confirmation since ${lastStakeSendingTime} (for ${elapsed} seconds)...`);

                        return;
                    }

                    debug(`WARN: participation hasn't been confirmed since ${lastStakeSendingTime} (for ${elapsed} seconds) - stake sending will be retried`);

                    _.invoke(this, 'sendNotification', {
                        event: 'PARTICIPATION_NOT_CONFIRMED',
                        context: { elapsed }
                    });
                }
            }

            if (activeElectionId === 0) {
                return;
            }

            debug(`INFO: elections ${activeElectionId}`);

            if (await this.datastore.skipNextElections()) {
                debug('INFO: these elections are configured to be skipped');

                return;
            }

            this.stakeSendingIsInProgress = true;

            await this.sendStakeImplDecorator(activeElectionId, maxFactor, retryAttempts);
        }
        catch (err) {
            _.invoke(this, 'sendNotification', {
                event: 'STAKE_SENDING_FAILED',
                context: {
                    errorMessage: _.get(err, 'message', 'N/A')
                }
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

    async getNewKeyPair() {
        const { stdout } = await this.execConsole('newkey');
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

        const electionStop = electionStart + validationPeriod;

        if (! _.every(requirement)) {
            throw new Error(`addKeysAndValidatorAddr: invalid argument(s) detected ${JSON.stringify({
                electionStart,
                electionStop,
                electionKey,
                electionADNLKey
            }, replacer)}`);
        }

        await this.execConsole(
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
            }, replacer)}`);
        }

        const { stdout } = await this.execConsole(`exportpub ${electionKey}`);

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
            }, replacer)}`);
        }

        const { stdout } = await this.execConsole(`sign ${electionKey} ${request}`);

        return _.get(stdout.match(/got signature: (?<signature>[0-9A-Fa-f]{128})/), 'groups.signature');
    }

    async execConsole(...commands) {
        const { console: opts } = await this.datastore.getSettings();

        return execConsole(opts, ...commands);
    }

    async getTimeDiff() {
        const { stdout } = await this.execConsole('getstats');
        const stats = JSON.parse(stdout);

        if (_.isNaN(stats.timediff)) {
            throw new Error('getTimeDiff: failed to get the value');
        }

        return -stats.timediff;
    }

    async getNodeVersion() {
        const { stdout } = await this.execConsole('getstats');
        const stats = JSON.parse(stdout);

        if (_.isNaN(stats.timediff)) {
            throw new Error('getNodeVersion: failed to get the value');
        }

        return stats.node_version;
    }
}

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

async function loadJSON(path) {
    return JSON.parse(await readFile(path));
}

