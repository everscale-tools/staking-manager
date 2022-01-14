import assert from 'assert/strict';
import * as fs from 'fs';
import crypto from 'crypto';
import { setTimeout } from 'timers/promises';
import _ from 'lodash';
import Debug from 'debug';
import Async from 'async';
import mem from 'mem';
import got from 'got';

const abiDePool = loadJSON('./contracts/solidity/depool/DePool.abi.json');
const abiWallet = loadJSON('./contracts/solidity/safemultisig/SafeMultisigWallet.abi.json');
const debug = Debug('lib:smp');

export default class StakingManagementPolicy {
    constructor(client, datastore, everscaleConfigParams, config) {
        this.client = client;
        this.datastore = datastore;
        this.everscaleConfigParams = everscaleConfigParams;
        this.wallet = config.wallet;
        this.funding = config.funding;
        this.webhooks = config.webhooks;
        this.participationConfirmationTimeout = _.get(config, 'participationConfirmationTimeout', 3600);
        this.flags = {
            maximizeConsoleUsage: _.chain(config).get('console.maximizeUsage', false).value(),
            stakeSendingIsInProgress: false
        }

        this.getConfigParamMemoized = mem(
            _.bind(this.getConfigParamImpl, this),
            { promise: true, length: 1 });
    }

    getConfigParam(id) {
        const freshOnly = _.some([34, 36], p => p === id);

        return freshOnly ? this.getConfigParamImpl(id) : this.getConfigParamMemoized(id);
    }

    getConfigParamImpl(id) {
        if (this.flags.maximizeConsoleUsage) {
            return this.getConfigViaConsole(id);
        }
        else {
            return this.everscaleConfigParams.get(id);
        }
    }

    async getElectorAddr() {
        return _
            .chain(await this.getConfigParam(1))
            .defaultTo('3333333333333333333333333333333333333333333333333333333333333333')
            .thru(addr => `-1:${addr}`)
            .value();
    }

    async getElectorBOC() {
        const electorAddr = await this.getElectorAddr();

        if (this.flags.maximizeConsoleUsage) {
            return this.getAccountStateViaConsole(electorAddr);
        }
        else {
            const result = await this.client.net.query_collection({
                collection: 'accounts',
                filter: { id: { eq: electorAddr } },
                result: 'boc'
            });
            const account = _.get(result, 'result.0.boc');

            if (_.isNil(account)) {
                throw new Error('failed to get account boc');
            }

            return account;
        }
    }

    submitTransaction(input, retryAttempts = 5) {
        const retryOpts = {
            times: retryAttempts,
            interval: count => 1000 * Math.pow(2, count - 1) // 1s, 2s, 4s ...
        }
        const task = cb => {
            const message_encode_params = {
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
            }

            if (this.flags.maximizeConsoleUsage) {
                this.sendMessageViaConsole(message_encode_params)
                    .then(_.partial(cb, null))
                    .catch(cb);
            }
            else {
                this.client.processing.process_message({ message_encode_params, send_events: false })
                    .then(_.partial(cb, null))
                    .catch(cb);
            }
        }

        return Async.retry(retryOpts, task);
    }

    async sendTicktock() {
        assert(_.get(this, 'funding.type') === 'depool');

        const { body } = await this.client.abi.encode_message_body({
            abi: {
                type: 'Contract',
                value: abiDePool
            },
            call_set: {
                function_name: 'ticktock',
                input: {}
            },
            is_internal: true,
            signer: { type: 'None' }
        });

        await this.submitTransaction({
            dest: this.funding.addr,
            value: 500000000,
            bounce: true,
            allBalance: false,
            payload: body
        });
    }

    async recoverStake(retryAttempts = 5) {
        const recoverAmount = await this.computeReturnedStake(
            _.chain(this.wallet.addr).split(':').nth(1).value()
        );

        if (recoverAmount !== 0) {
            // recover-stake.fif
            const writeInteger = (value, size) => ({ type: 'Integer', size, value });
            const { boc: payload } = await this.client.boc.encode_boc({
                builder: [
                    writeInteger(0x47657424, 32),
                    writeInteger(Math.floor(Date.now() / 1000), 64)
                ]
            });

            if (_.isEmpty(payload)) {
                throw new Error('recoverStake: recover query payload is empty');
            }

            const result = await this.submitTransaction({
                dest: await this.getElectorAddr(),
                value: 1000000000,
                bounce: true,
                allBalance: false,
                payload
            }, retryAttempts);

            if (_.get(result, 'transaction.action.success')) {
                debug('INFO: submitTransaction attempt... PASSED');
                debug(`INFO: recover of ${recoverAmount} nanotoken(s) is requested`);
            }
            else {
                debug('INFO: submitTransaction attempt... FAILED');

                throw new Error(result);
            }
        }
        else {
            debug('INFO: nothing to recover');
        }
    }

    async getWalletBalance() {
        const addr = this.wallet.addr;

        if (this.flags.maximizeConsoleUsage) {
            const account = await this.getAccountViaConsole(addr);

            return account.balance;
        }
        else {
            const { result } = await this.client.net.query_collection({
                collection: 'accounts',
                filter: { id: { eq: addr } },
                result: 'balance'
            });

            return _.chain(result).nth(0).get('balance').parseInt().value();
        }
    }

    skipNextElections(skip) {
        return this.datastore.skipNextElections(skip);
    }

    async setNextStakeSize(value) {
        const result = await this.datastore.nextStakeSize(value);

        debug(`INFO: stake size is set to ${value}`);

        return result;
    }

    async getMinStake() {
        return _
            .chain(await this.getConfigParam(17))
            .get('min_stake')
            .defaultTo(0x9184e72a000)
            .parseInt()
            .value();
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
            const result = await this.submitTransaction({
                dest: dstAddr,
                value: stake * 1000000000,
                bounce: true,
                allBalance: false,
                payload
            }, retryAttempts);

            if (_.get(result, 'transaction.action.success')) {
                debug('INFO: stake sending attempt... PASSED');

                dbEntry.lastStakeSendingTime = Math.floor(Date.now() / 1000);
            }
            else {
                debug('INFO: stake sending attempt... FAILED');

                throw new Error(result);
            }
        }
        finally {
            await this.datastore.setElectionsInfo(dbEntry, incStake);
        }
    }

    async sendStakeViaWallet(electionId, cumulativeStake, sendOnce, maxFactor, retryAttempts) {
        assert(_.get(this, 'funding.type') === 'wallet');

        debug('INFO: participating via wallet...');

        const stake = _.defaultTo(await this.datastore.nextStakeSize(), this.funding.defaultStake);
        const nanostake = stake * 1000000000;
        const walletAddr = this.wallet.addr;
        const balance = await this.getWalletBalance();

        if (nanostake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${walletAddr} wallet`);
        }

        const minStake = await this.getMinStake();

        if (cumulativeStake === 0 && nanostake < minStake) {
            throw new Error(`Initial stake is less than min stake allowed (${nanostake} < ${minStake})`);
        }

        const { totalStake } = await this.getParticipantListExtended();
        const minTotalStakeFractionAllowed = _.ceil(totalStake / 4096);

        if (nanostake < minTotalStakeFractionAllowed) {
            throw new Error(`No way to send less than ${minTotalStakeFractionAllowed} nanotokens at the moment`);
        }

        const electorAddr = await this.getElectorAddr();

        await this.sendStakeImpl(electionId, walletAddr, electorAddr, stake, true, maxFactor, retryAttempts);
    }

    async sendStakeViaDePool(electionId, maxFactor, retryAttempts) {
        assert(_.get(this, 'funding.type') === 'depool');

        debug('INFO: participating via depool...');

        const depoolAddr = this.funding.addr;
        const proxyAddr = await Async.retry(
            { times: 3 },
            async () => {
                await this.sendTicktock();
                await setTimeout(60000);

                // Extract a proxy address from depool events...
                const eventBody = await lookForDePoolEvent(
                    this.client,
                    depoolAddr,
                    _.matches({
                        body: {
                            name: 'StakeSigningRequested',
                            value: {
                                electionId: _.toString(electionId)
                            }
                        }
                    }));
                const proxyAddr = _.get(eventBody, 'value.proxy');

                if (_.isNil(proxyAddr)) {
                    throw new Error('Unable to detect relevant proxy address in depool events');

                    // TODO: provide diagnostic data such as DePool balance, recent events, etc.
                }

                return proxyAddr;
            }
        );

        debug(`INFO: depool proxy address is ${proxyAddr}`);

        await this.sendStakeImpl(electionId, proxyAddr, depoolAddr, 1, false, maxFactor, retryAttempts);
    }

    async sendStake(sendOnce = true, maxFactor = 3, retryAttempts = 5) {
        const fundingType = _.get(this, 'funding.type')
        const activeElectionId = await this.getActiveElectionId();

        if (activeElectionId === 0) {
            debug('INFO: no current elections');

            if (fundingType !== 'depool') return;

            const electionsInfo = await this.datastore.getElectionsInfo();
            const dbEntry = _.last(electionsInfo);

            if (dbEntry.postElectionsTicktockIsSent) return;

            const p36 = await this.getConfigParam(36); // it will be null when new validators start doing their job

            if (!_.isNil(p36)) return;

            await this.sendTicktock();

            debug('INFO: post-elections ticktock is sent');

            dbEntry.postElectionsTicktockIsSent = true;

            await this.datastore.setElectionsInfo(dbEntry);

            return;
        }

        debug(`INFO: elections ${activeElectionId}`);

        if (await this.datastore.skipNextElections()) {
            debug(`INFO: these elections are configured to be skipped`);

            return;
        }

        if (this.flags.stakeSendingIsInProgress) {
            debug('INFO: stake sending is already in progress...');

            return;
        }

        const dbEntry = await this.datastore.getElectionsInfo(activeElectionId);
        const publicKey = _.get(dbEntry, 'publicKey');

        if (publicKey) {
            const participationConfirmed = _.get(dbEntry, 'participationConfirmed', false);

            if (participationConfirmed) {
                debug(`INFO: already participating: pubkey=0x${publicKey}, stake=${dbEntry.stake}`);

                if (fundingType === 'depool' || sendOnce) {
                    return;
                }
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

                    if (fundingType === 'depool' || sendOnce) {
                        return;
                    }
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

        this.flags.stakeSendingIsInProgress = true;

        try {
            switch (fundingType) {
                case 'wallet': await this.sendStakeViaWallet(activeElectionId, _.get(dbEntry, 'stake', 0), sendOnce, maxFactor, retryAttempts); break;
                case 'depool': await this.sendStakeViaDePool(activeElectionId, maxFactor, retryAttempts); break;
                default: throw new Error('sendStake: unknown funding type');
            }
        }
        catch (err) {
            await this.callWebhook({
                subject: 'STAKE_SENDING_FAILED',
                context: _.get(err, 'message', 'N/A')
            });

            throw err;
        }
        finally {
            this.flags.stakeSendingIsInProgress = false;
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
}

async function lookForDePoolEvent(client, depoolAddress, isWhatWeAreLookingFor) {
    const { result } = await client.net.query_collection({
        collection: 'messages',
        filter: {
            src: { eq: depoolAddress },
            msg_type: { eq: 2 },
            created_at: { gt: Math.floor(Date.now() / 1000) - 86400 }
        },
        result: 'body'
    });

    for (const entry of result) {
        const encodedBody = _.get(entry, 'body');

        if (_.isNil(encodedBody)) continue;

        entry.body = await client.abi.decode_message_body({
            abi: {
                type: 'Contract',
                value: abiDePool
            },
            body: encodedBody,
            is_internal: true
        });
    }

    return _
        .chain(result)
        .findLast(isWhatWeAreLookingFor)
        .get('body')
        .value();
}

function loadJSON(path) {
    return JSON.parse(fs.readFileSync(path));
}

