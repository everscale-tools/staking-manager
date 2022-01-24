import _ from 'lodash';
import Debug from 'debug';
import everscaleConfigParamSubfields from './everscale-config-params-subfields.js';

const debug = Debug('lib:everos-blockchain-interactions');

export default (superclass) => class extends superclass {
    constructor(client, datastore) {
        super(client, datastore);

        this.client = client;

        debug('INFO: everos usage is maximized');
    }

    async submitTransactionImpl(params) {
        const { message } = await this.client.abi.encode_message(params);

        await this.client.processing.send_message({
            message,
            send_events: false
        });
    }

    async getConfigParamImpl(id) {
        const seqnoQueryResult = await this.client.net.query_collection({
            collection: 'blocks',
            filter: {},
            order: [{ path: 'seq_no', direction: 'DESC' }],
            result: 'id prev_key_block_seqno',
            limit: 1
        });
        const prevKeyBlockSeqno = _.get(seqnoQueryResult, 'result.0.prev_key_block_seqno');

        if (_.isNil(prevKeyBlockSeqno)) {
            throw new Error('failed to obtain prev_key_block_seqno');
        }

        const configParamQueryResult = await this.client.net.query_collection({
            collection: 'blocks',
            filter: {
                seq_no: { eq: prevKeyBlockSeqno },
                workchain_id: { eq: -1 }
            },
            result: `master { config { p${id} ${everscaleConfigParamSubfields[`p${id}`]} } }`
        });

        return _.get(configParamQueryResult, `result.0.master.config.p${id}`);
    }

    async getAccountStateImpl(address) {
        const result = await this.client.net.query_collection({
            collection: 'accounts',
            filter: { id: { eq: address } },
            result: 'boc'
        });
        const account = _.get(result, 'result.0.boc');

        if (_.isNil(account)) {
            throw new Error('failed to get account boc');
        }

        return account;
    }

    async getAccountBalance(address) {
        const { result } = await this.client.net.query_collection({
            collection: 'accounts',
            filter: { id: { eq: address } },
            result: 'balance'
        });

        return _.chain(result).nth(0).get('balance').parseInt().value();
    }
};

