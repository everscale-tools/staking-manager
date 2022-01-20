import { readFile } from 'fs/promises';
import { setTimeout } from 'timers/promises';
import _ from 'lodash';
import Async from 'async';
import Debug from 'debug';

const abiDePool = await loadJSON('./contracts/solidity/depool/DePool.abi.json');
const debug = Debug('lib:depool-funding');

export default (superclass) => class extends superclass {
    constructor(client, datastore, config) {
        super(client, datastore, config);

        this.client = client;
        this.datastore = datastore;
        this.depoolAddress = _.get(config, 'funding.addr');

        debug('INFO: depool funding is in action');
    }

    async performOutOfElectionsAction() {
        const electionsInfo = await this.datastore.getElectionsInfo();
        const dbEntry = _.last(electionsInfo);

        if (dbEntry.postElectionsTicktockIsSent) return;

        const p36 = await super.getConfigParam(36); // it will be null when new validators start doing their job

        if (!_.isNil(p36)) return;

        await this.sendTicktock();

        debug('INFO: post-elections ticktock is sent');

        dbEntry.postElectionsTicktockIsSent = true;

        await this.datastore.setElectionsInfo(dbEntry);
    }

    async sendTicktock() {
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

        await super.submitTransaction({
            dest: this.depoolAddress,
            value: 500000000,
            bounce: true,
            allBalance: false,
            payload: body
        });
    }

    async sendStakeImplDecorator(electionId, maxFactor, retryAttempts) {
        debug('INFO: participating via depool...');

        const proxyAddr = await Async.retry(
            { times: 3 },
            async () => {
                await this.sendTicktock();
                await setTimeout(60000);

                // Extract a proxy address from depool events...
                const eventBody = await lookForDePoolEvent(
                    this.client,
                    this.depoolAddress,
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

        await super.sendStakeImpl(
            electionId,
            proxyAddr,
            this.depoolAddress,
            1,
            false,
            maxFactor,
            retryAttempts
        );
    }
};

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

async function loadJSON(path) {
    return JSON.parse(await readFile(path));
}

