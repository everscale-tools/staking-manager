import _ from 'lodash';
import { TonClient } from '@tonclient/core';
import { libNode } from '@tonclient/lib-node';
import Datastore from './datastore.js';
import StakingManagementPolicy from './smp.js';
import DePoolFunding from './depool-funding.js';
import WalletFunding from './wallet-funding.js';
import EverosBlockchainInteractions from './everos-blockchain-interactions.js';
import IndependentBlockchainInteractions from './independent-blockchain-interactions.js';
import ElectorFunctions from './elector-functions.js';
import { mix } from 'mixwith';

TonClient.useBinaryLibrary(libNode);

function ConfigurableBase(config) {
    let mixins = [ElectorFunctions]; // order matters

    if (_.get(config, 'console.maximizeUsage') === true) {
        mixins.push(IndependentBlockchainInteractions);
    }
    else {
        mixins.push(EverosBlockchainInteractions);
    }

    switch (_.get(config, 'funding.type')) {
    case 'depool': mixins.push(DePoolFunding); break;
    case 'wallet': mixins.push(WalletFunding); break;
    default: throw new Error('unknown funding type');
    }

    return mix(StakingManagementPolicy).with(...mixins);
}

export default class StakingManagerClassBuilder {
    static build(config) {
        return class StakingManager extends ConfigurableBase(config) {
            constructor(client, datastore, config) {
                super(client, datastore, config);

                this.client = client;
                this.datastore = datastore;
            }

            static async create() {
                const client = new TonClient(config.everos);
                const datastore = new Datastore(config.datastore.path);

                return new StakingManager(client, datastore, config);
            }

            async getElectionsHistory() {
                const fields = ['id', 'key', 'publicKey', 'adnlKey', 'stake', 'lastStakeSendingTime', 'participationConfirmed'];
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
                };
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
                    .map('publicKey')
                    .map(_.toLower)
                    .value();
                const p34 = await this.getConfigParam(34);
                const totalWeight = _
                    .chain(p34)
                    .pick(['total_weight_dec', 'total_weight'])
                    .thru(({ total_weight_dec: d, total_weight: x }) => d ? [d, 10] : [x, 16])
                    .thru(params => _.parseInt(...params))
                    .value();
                const weights = _.map(keys, public_key => _
                    .chain(p34)
                    .get('list')
                    .find({ public_key })
                    .pick(['weight_dec', 'weight'])
                    .thru(({ weight_dec: d, weight: x }) => d ? [d, 10] : [x, 16])
                    .thru(params => _.parseInt(...params))
                    .divide(totalWeight)
                    .value());
                const weightId = _.findIndex(weights, _.isFinite);

                if (weightId === -1) {
                    return {
                        stake: 0,
                        weight: 0
                    };
                }

                const pastElectionsInfo = await this.getPastElections();
                const parseList = list => {
                    if (_.isNil(list)) {
                        return [];
                    }

                    const [[,,,,, totalStake], tail] = list;

                    return [parseInt(totalStake), ...parseList(tail)];
                };
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
                };
            }
        };
    }
}

