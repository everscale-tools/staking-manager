import Async from 'async';
import _ from 'lodash';

export default (superclass) => class extends superclass {
    constructor(client, datastore, config) {
        super(client, datastore, config);

        this.runGetQueue = Async.queue((params, cb) => {
            client.tvm.run_get(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    runGet(params) {
        return new Promise((resolve, reject) => {
            this.runGetQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    getElectorBOC() {
        return super.getAccountState(
            '-1:3333333333333333333333333333333333333333333333333333333333333333'
        );
    }

    async getActiveElectionId() {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
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
            account: await this.getElectorBOC(),
            function_name: 'past_election_ids'
        });

        return _
            .chain(result)
            .get('output.0')
            .map(_.unary(parseInt))
            .filter(_.isNumber)
            .value();
    }

    async participatesIn(publicKey) {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'participates_in',
            input: [`0x${publicKey}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to check if the key participates in current elections');
        }

        return parseInt(value);
    }

    async getParticipantListExtended() {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
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
            };

            return [head, ...parseList(tail)];
        };

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

    async computeReturnedStake(accountId) {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'compute_returned_stake',
            input: [`0x${accountId}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to compute returned stake');
        }

        return parseInt(value);
    }

    async getPastElections() {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'past_elections'
        });

        return result;
    }
};

