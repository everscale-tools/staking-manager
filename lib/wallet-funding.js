import _ from 'lodash';
import Debug from 'debug';

const debug = Debug('lib:wallet-funding');

export default (superclass) => class extends superclass {
    constructor(client, datastore, config) {
        super(client, datastore, config);

        this.client = client;
        this.datastore = datastore;
        this.walletAddress = _.get(config, 'wallet.addr');
        this.electorAddress = '-1:3333333333333333333333333333333333333333333333333333333333333333';
    }

    performOutOfElectionsAction() {
        return Promise.resolve();
    }

    async sendStakeImplDecorator(electionId, maxFactor, retryAttempts) {
        debug('INFO: participating via wallet...');

        const dbEntry = await this.datastore.getElectionsInfo(electionId);
        const cumulativeStake = _.get(dbEntry, 'stake', 0);
        const stake = _.defaultTo(await this.datastore.nextStakeSize(), super.funding.defaultStake);
        const nanostake = stake * 1000000000;
        const balance = await super.getAccountBalance(this.walletAddress);

        if (nanostake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${this.walletAddress} wallet`);
        }

        const minStake = await this.getMinStake();

        if (cumulativeStake === 0 && nanostake < minStake) {
            throw new Error(`Initial stake is less than min stake allowed (${nanostake} < ${minStake})`);
        }

        const { totalStake } = await super.getParticipantListExtended();
        const minTotalStakeFractionAllowed = _.ceil(totalStake / 4096);

        if (nanostake < minTotalStakeFractionAllowed) {
            throw new Error(`No way to send less than ${minTotalStakeFractionAllowed} nanotokens at the moment`);
        }

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

