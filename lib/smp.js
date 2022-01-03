const debug = require('debug')('lib:smp');
const assert = require('assert').strict;
const crypto = require('crypto');
const _ = require('lodash');
const Async = require('async');
const mem = require('mem');
const abiDePool = require('../contracts/solidity/depool/DePool.abi.json')
const abiWallet = require('../contracts/solidity/safemultisig/SafeMultisigWallet.abi.json');

class StakingManagementPolicy {
    constructor(client, datastore, everscaleConfigParams, config) {
        this.client = client;
        this.datastore = datastore;
        this.everscaleConfigParams = everscaleConfigParams;
        this.wallet = config.wallet;
        this.funding = config.funding;
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

    async getValidationPeriod() {
        return _
            .chain(await this.getConfigParam(15))
            .get('validators_elected_for')
            .defaultTo(65536)
            .value();
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

    sendTicktock(times = 1, delay = 0) {
        assert(_.get(this, 'funding.type') === 'depool');

        return new Promise((resolve, reject) => {
            Async.waterfall([
                cb => {
                    const args = {
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
                    }

                    this.client.abi.encode_message_body(args)
                        .then(result => cb(null, result.body))
                        .catch(cb);
                },
                (payload, cb) => {
                    const args = {
                        dest: this.funding.addr,
                        value: 500000000,
                        bounce: true,
                        allBalance: false,
                        payload
                    }

                    Async.timesSeries(times, (n, next) => {
                        Async.waterfall([
                            cb => {
                                this.submitTransaction(args)
                                    .then(() => cb())
                                    .catch(cb);
                            },
                            cb => (delay > 0) ? setTimeout(cb, delay) : cb()
                        ], next);
                    }, cb);
                }
            ], err => _.isNil(err) ? resolve() : reject(err));
        });
    }

    async recoverStake(retryAttempts = 5) {
        const recoverAmount = await this.computeReturnedStake(
            _.chain(this.wallet.addr).split(':').nth(1).value()
        );

        if (recoverAmount !== 0) {
            const payload = await this.genRecoverQuery(this.client);

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

    async sendStakeImpl(dbEntry, srcAddr, dstAddr, stake, maxFactor, retryAttempts) {
        if (! _.every(['key', 'adnlKey'], _.partial(_.has, dbEntry))) {
            const { key, secret } = await this.getNewKeyPair();
            const { key: adnlKey, secret: adnlSecret } = await this.getNewKeyPair();

            dbEntry.key = key;
            dbEntry.adnlKey = adnlKey;
            dbEntry.secrets = [secret, adnlSecret];

            const validationPeriod = await this.getValidationPeriod();

            await this.addKeysAndValidatorAddr(dbEntry.id, validationPeriod, dbEntry.key, dbEntry.adnlKey);
        }

        if (! _.has(dbEntry, 'publicKey')) {
            const request = await StakingManagementPolicy.genValidatorElectReq(
                srcAddr, dbEntry.id, maxFactor, dbEntry.adnlKey);

            dbEntry.publicKey = await this.exportPub(dbEntry.key);
            dbEntry.signature = await this.signRequest(dbEntry.key, request);
        }

        const payload = await StakingManagementPolicy.genValidatorElectSigned(
            this.client, srcAddr, dbEntry.id, maxFactor, dbEntry.adnlKey, dbEntry.publicKey, dbEntry.signature);
        const result = await this.submitTransaction({
            dest: dstAddr,
            value: stake * 1000000000,
            bounce: true,
            allBalance: false,
            payload
        }, retryAttempts);

        if (_.get(result, 'transaction.action.success')) {
            debug('INFO: stake sending attempt... PASSED');
        }
        else {
            debug('INFO: stake sending attempt... FAILED');

            throw new Error(result);
        }
    }

    async sendStakeViaWallet(dbEntry, sendOnce, maxFactor, retryAttempts) {
        assert(_.get(this, 'funding.type') === 'wallet');

        const stake = _.defaultTo(await this.datastore.nextStakeSize(), this.funding.defaultStake);
        const nanostake = stake * 1000000000;
        const walletAddr = this.wallet.addr;
        const balance = await this.getWalletBalance();

        if (nanostake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${walletAddr} wallet`);
        }

        const cumulativeStake = _.get(dbEntry, 'stake', 0);
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

        await this.sendStakeImpl(dbEntry, walletAddr, electorAddr, stake, maxFactor, retryAttempts);
    }

    async sendStakeViaDePool(dbEntry, maxFactor, retryAttempts) {
        assert(_.get(this, 'funding.type') === 'depool');

        await this.sendTicktock(2, 60000);

        const depoolAddr = this.funding.addr;

        // Extract a proxy address from depool events...
        const eventBody = await lookForDePoolEvent(
            this.client,
            depoolAddr,
            _.matches({
                body: {
                    name: 'StakeSigningRequested',
                    value: {
                        electionId: dbEntry.id.toString()
                    }
                }
            }));
        const proxyAddr = _.get(eventBody, 'value.proxy');

        if (_.isNil(proxyAddr)) {
            throw new Error('Unable to detect relevant proxy address in DePool events');
        }

        debug(`INFO: DePool proxy address is ${proxyAddr}`);

        await this.sendStakeImpl(dbEntry, proxyAddr, depoolAddr, 1, maxFactor, retryAttempts);
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
                            debug(`WARN: participation hasn't been confirmed since ${lastStakeSendingTime} (for ${elapsed} seconds) - stake sending will be retried`);

                            // TODO: provide diagnostic data such as DePool balance, recent events, etc.
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

        let stakeSendingSucceeded = true;

        try {
            switch (fundingType) {
                case 'wallet': await this.sendStakeViaWallet(dbEntry, sendOnce, maxFactor, retryAttempts); break;
                case 'depool': await this.sendStakeViaDePool(dbEntry, maxFactor, retryAttempts); break;
                default: throw new Error('sendStake: unknown funding type');
            }
        }
        catch (err) {
            stakeSendingSucceeded = false;

            throw err;
        }
        finally {
            if (stakeSendingSucceeded) {
                dbEntry.lastStakeSendingTime = Math.floor(Date.now() / 1000);
            }

            await this.datastore.setElectionsInfo(dbEntry);

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

    static async genRecoverQuery(client) {
        const writeInteger = (value, size) => ({ type: 'Integer', size, value });
        const { boc } = await client.boc.encode_boc({
            builder: [
                writeInteger(0x47657424, 32),
                writeInteger(Math.floor(Date.now() / 1000), 64)
            ]
        });

        return boc;
    }

    static async genValidatorElectReq(walletAddr, electionStart, maxFactor, electionADNLKey) {
        const requirement = [
            _.isString(walletAddr), !_.isEmpty(walletAddr),
            _.isInteger(electionStart),
            _.isInteger(maxFactor),
            _.isString(electionADNLKey), !_.isEmpty(electionADNLKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`genValidatorElectReq: invalid argument(s) detected ${JSON.stringify({
                walletAddr,
                electionStart,
                maxFactor,
                electionADNLKey
            }, replacer, 2)}`);
        }

        const walletId = _.chain(walletAddr).split(':').nth(1).value();
        const buffers = [
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.from(walletId, 'hex'),
            Buffer.from(electionADNLKey, 'hex')
        ];

        buffers[0].writeUInt32BE(0x654C5074);
        buffers[1].writeUInt32BE(electionStart);
        buffers[2].writeUInt32BE(maxFactor * 65536.0);

        return Buffer.concat(buffers).toString('hex');
    }

    static async genValidatorElectSigned(client, walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature) {
        /*
        const ok = crypto.verify(
            'ed25519',
            Buffer.from(result, 'base64'),
            Buffer.from(publicKey, 'hex'),
            Buffer.from(signature, 'hex')); // <- throws an error

        debug(`genValidatorElectSigned: signature verified: ${ok}`);
        */

        const writeInteger = (value, size) => ({ type: 'Integer', size, value });
        const writeBitString = (value) => ({ type: 'BitString', value });
        const { boc } = await client.boc.encode_boc({
            builder: [
                writeInteger(0x4E73744B, 32),
                writeInteger(Math.floor(Date.now() / 1000), 64),
                writeBitString(publicKey),
                writeInteger(electionStart, 32),
                writeInteger(_.round(maxFactor * 65536.0), 32),
                writeInteger(`0x${electionADNLKey}`, 256),
                { type: 'Cell', builder: [writeBitString(signature)] }
            ]
        });

        return boc;
    }
}

function replacer(key, value) {
    return _.isNil(value) ? null : value;
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

function waitForDePoolEvent(client, depoolAddress, timeout, isWhatWeAreWaitingFor) {
    return new Promise(async (resolve, reject) => {
        let subscription;
        let timeoutObject;

        const onError = err => {
            clearTimeout(timeoutObject);

            if (subscription) {
                client.net.unsubscribe(subscription);
            }

            reject(err);
        }
        const onDocEvent = async ({ result: doc }) => {
            try {
                const encodedBody = _.get(doc, 'body');

                if (_.isNil(encodedBody)) return;

                doc.body = await client.abi.decode_message_body({
                    abi: {
                        type: 'Contract',
                        value: abiDePool
                    },
                    body: encodedBody,
                    is_internal: true
                });

                if (isWhatWeAreWaitingFor(doc)) {
                    await client.net.unsubscribe(subscription);

                    clearTimeout(timeoutObject);

                    resolve(_.get(doc, 'body'));
                }
            }
            catch (err) {
                onError(err);
            }
        }

        try {
            const subscriptionParams = {
                collection: 'messages',
                filter: {
                    src: { eq: depoolAddress },
                    msg_type: { eq: 2 }
                },
                result: 'body'
            }

            subscription = await client.net.subscribe_collection(subscriptionParams, onDocEvent);

            timeoutObject = setTimeout(() => {
                onError(new Error('time is out while waiting for a depool event'));
            }, timeout);
        }
        catch (err) {
            onError(err);
        }
    });
}

module.exports = StakingManagementPolicy;
