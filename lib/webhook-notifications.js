import _ from 'lodash';
import Debug from 'debug';
import got from 'got';

const debug = Debug('lib:webhook-notifications');

export default (superclass) => class extends superclass {
    constructor(client, datastore) {
        super(client, datastore);

        this.datastore = datastore;
    }

    async sendNotification(json) {
        const settings = await this.datastore.getSettings();
        const opts = _.get(settings, 'webhook');

        if (_.isPlainObject(opts)) {
            try {
                await got({ ...opts, json });
            }
            catch (err) {
                debug(`WARN: webhook failed with error ${_.toString(err)}`);
            }
        }
    }
};

