'use strict';

const _ = require('lodash');
const { TonClient } = require('@tonclient/core');
const { libNode } = require('@tonclient/lib-node');
const Datastore = require('./datastore');
const EverscaleConfigParams = require('./everscale-config-params');
const StakingManagementPolicy = require('./modern-smp');
const config = require('../config');

TonClient.useBinaryLibrary(libNode);

class StakingManager extends StakingManagementPolicy {
    constructor(client, datastore, everscaleConfigParams, config) {
        super(client, datastore, everscaleConfigParams, config);

        this.client = client;
        this.datastore = datastore;
    }

    static async create() {
        const client = new TonClient(config.everos);
        const datastore = new Datastore(config.datastore);
        const everscaleConfigParams = new EverscaleConfigParams(client);

        return new StakingManager(client, datastore, everscaleConfigParams, config);
    }

    async getElectionsHistory() {
        const fields = ['id', 'publicKey', 'adnlKey', 'stake', 'lastStakeSendingTime', 'participationConfirmed'];
        const info = await this.datastore.getElectionsInfo();

        return _.chain(info).map(doc => _.pick(doc, fields)).value();
    }

    async countBlocksSignatures(interval) {
        const le = Math.floor(Date.now() / 1000);
        const [prevKey, curKey] = _
            .chain(await this.datastore.getElectionsInfo())
            .takeRight(2)
            .map('key')
            .map(_.toLower)
            .value();
        const filter = {
            gen_utime: { gt: le - interval, le },
            signatures: {
                any: {
                    node_id: { eq: curKey },
                    OR: { node_id: { eq: prevKey } }
                }
            }
        }
        const { result } = await this.client.net.query_collection({
            collection: 'blocks_signatures',
            filter,
            result: 'id'
        });

        return _.size(result);
    }

    async getLatestStakeAndWeight() {
        const keys = _
            .chain(await this.datastore.getElectionsInfo())
            .takeRight(2)
            .map('adnlKey')
            .map(_.toLower)
            .value();
        const p34 = await this.getConfigParam(34);
        const totalWeight = _.chain(p34).get('total_weight').parseInt(16).value();
        const weights = _.map(keys, adnl_addr => _
            .chain(p34)
            .get('list')
            .find({ adnl_addr })
            .get('weight')
            .parseInt(16)
            .divide(totalWeight)
            .value());
        const weightId = _.findIndex(weights, _.negate(_.isNaN));

        if (weightId === -1) {
            return {
                stake: 0,
                weight: 0
            }
        }

        const pastElectionsInfo = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'past_elections'
        });
        const parseList = list => {
            if (_.isNil(list)) {
                return [];
            }

            const [[,,,,, totalStake], tail] = list;

            return [parseInt(totalStake), ...parseList(tail)];
        }
        const totalStake = _
            .chain(pastElectionsInfo)
            .get('output.0')
            .thru(parseList)
            .thru(stakes => _.nth(stakes, weightId % _.size(stakes)))
            .value();
        const weight = weights[weightId];

        return {
            stake: totalStake * weight,
            weight
        }
    }
}

module.exports = StakingManager;
