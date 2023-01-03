import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import * as fs from 'node:fs/promises';

const readonly = true;

export default class Datastore {
    constructor(path) {
        this.path = path;
    }

    async dbOp(op, readonly = false) {
        if (_.isNil(this.db)) {
            await fs.mkdir(path.dirname(this.path), { recursive: true });

            this.db = new Low(new JSONFile(this.path));

            await this.db.read();

            this.db.data ||= {};
        }

        const result = op();

        if (!readonly) {
            await this.db.write();
        }

        return result;
    }

    skipNextElections(value) {
        return this.dbOp(() => {
            if (_.isNil(value)) {
                return this.db.data.settings.skipNextElections;
            }
            else {
                const skipNextElections = Boolean(value);

                _.set(this.db, 'data.settings.skipNextElections', skipNextElections);

                return skipNextElections;
            }
        });
    }

    getFundingAddress() {
        return this.dbOp(_.constant(this.db.data.settings.funding.addr), readonly);
    }

    getWalletAddress() {
        return this.dbOp(_.constant(this.db.data.settings.wallet.addr), readonly);
    }

    getWalletKeys() {
        return this.dbOp(_.constant(this.db.data.settings.wallet.keys), readonly);
    }

    getSettings() {
        return this.dbOp(_.constant(this.db.data.settings), readonly);
    }

    setSettings(value) {
        return this.dbOp(() => {
            const path = 'data.settings';
            const updated = _
                .chain(this.db)
                .get(path, {})
                .thru(current => _.defaultsDeep(value, current))
                .value();

            _.set(this.db, path, updated);

            return updated;
        });
    }

    getElectionsInfo(id) {
        return this.dbOp(() => {
            if (_.isNumber(id)) {
                return _
                    .chain(this.db)
                    .get('data.elections')
                    .find({ id })
                    .defaultTo({ id })
                    .value();
            }
            else {
                return _
                    .chain(this.db)
                    .get('data.elections')
                    .defaultTo([])
                    .value();
            }
        }, readonly);
    }

    setElectionsInfo(info, incStake = false) {
        return this.dbOp(() => {
            const id = _.get(info, 'id');

            if (_.isNumber(id)) {
                _.update(this.db, 'data.elections', _.partialRight(_.defaultTo, []));

                const elections = _.get(this.db, 'data.elections');
                const index = _.findLastIndex(elections, { id });

                if (index < 0) {
                    elections.push(info);

                    return info;
                }

                if (incStake) {
                    const value = _.get(elections, [index, 'stake'], 0);

                    elections[index] = {
                        ...info,
                        stake: _.add(value, info.stake)
                    };
                }
                else {
                    elections[index] = info;
                }

                return elections[index];
            }
            else {
                throw new Error('id is missing');
            }
        });
    }
}
