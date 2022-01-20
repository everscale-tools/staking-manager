import { setTimeout } from 'timers/promises';
import _ from 'lodash';
import Async from 'async';
import Debug from 'debug';

const debug = Debug('lib:wallet-funding');

export default (superclass) => class extends superclass {
    constructor(client, datastore, config) {
        super(client, datastore, config);

        this.client = client;
        this.datastore = datastore;
        this.walletAddress = _.get(config, 'wallet.addr');
        this.electorAddress = '-1:3333333333333333333333333333333333333333333333333333333333333333';

        debug('INFO: wallet funding is in action');
    }

    performOutOfElectionsAction() {
        return Promise.resolve();
    }

    async sendStakeImplDecorator(electionId, maxFactor, retryAttempts) {
        debug('INFO: participating via wallet...');

        const stake = await Async.retry(
            { times: 3 },
            async () => {
                await this.recoverStake();
                await setTimeout(60000);

                const lastPubKey = _
                    .chain(await this.datastore.getElectionsInfo())
                    .findLast(({ id }) => id !== electionId)
                    .get('publicKey')
                    .value();
                const validatingNow = _
                    .chain(await super.getConfigParam(34))
                    .get('list')
                    .find({ public_key: lastPubKey })
                    .thru(Boolean)
                    .value();
                const balance = await super.getAccountBalance(this.walletAddress);
                const minStake = await this.getMinStake();
                const optimalSafetyMargin = 10_000_000_000;
                const criticalSafetymargin = 1_000_000_000;

                let stake;

                if (validatingNow) {
                    stake = _.max([minStake, balance - optimalSafetyMargin]);
                }
                else {
                    stake = _.max([minStake, balance / 2 - optimalSafetyMargin]);
                }

                if (balance < (stake + criticalSafetymargin)) {
                    throw new Error(
                        `Not enough tokens (${balance}) in ${this.walletAddress} wallet to send a minimally
                        allowed stake (${minStake}) with a critical safety margin of ${criticalSafetymargin}`
                    );
                }

                return _.floor(stake / 1_000_000_000);
            }
        );

        await super.sendStakeImpl(
            electionId,
            this.walletAddress,
            this.electorAddress,
            stake,
            true,
            maxFactor,
            retryAttempts
        );
    }

    async recoverStake(retryAttempts = 5) {
        const recoverAmount = await super.computeReturnedStake(
            _.chain(this.walletAddress).split(':').nth(1).value()
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

            await super.submitTransaction({
                dest: this.electorAddress,
                value: 500000000,
                bounce: true,
                allBalance: false,
                payload
            }, retryAttempts);
        }

        return recoverAmount;
    }

    async getMinStake() {
        return _
            .chain(await super.getConfigParam(17))
            .get('min_stake')
            .defaultTo(0x9184e72a000)
            .parseInt()
            .value();
    }
};

