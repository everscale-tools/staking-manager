import _ from 'lodash';
import Async from 'async';
import { Low, JSONFile } from 'lowdb';
import path from 'path';
import * as fs from 'fs';

export default class Datastore {
    constructor(path) {
        this.path = path;
    }

    dbOp(op) {
        return Async.waterfall([
            cb => {
                if (_.get(this, 'db.data')) {
                    return cb();
                }

                Async.waterfall([
                    cb => {
                        fs.mkdir(path.dirname(this.path), { recursive: true }, cb);
                    },
                    cb => {
                        fs.stat(this.path, cb);
                    },
                    ({ size }, cb) => {
                        if (size === 0) {
                            return fs.writeFile(this.path, '{}', cb);
                        }

                        return cb();
                    }
                ], err => {
                    if (_.isNil(err) || (err.code === 'ENOENT')) {
                        return cb();
                    }

                    return cb(err);
                });
            },
            cb => {
                if (_.get(this, 'db.data')) {
                    return cb();
                }

                this.db = new Low(new JSONFile(this.path));

                this.db.read()
                    .then(() => cb())
                    .catch(cb);
            },
            op,
            (result, cb) => {
                this.db.write()
                    .then(() => cb(null, result))
                    .catch(cb);
            }
        ]);
    }

    nextStakeSize(value) {
        return this.dbOp(cb => {
            if (_.isNil(value)) {
                const nextStakeSize = _.get(this.db, 'data.config.nextStakeSize');

                return cb(null, nextStakeSize);
            }
            else {
                const nextStakeSize = (_.isInteger(value) && (value > 0)) ? value : null;

                _.set(this.db, 'data.config.nextStakeSize', nextStakeSize);

                return cb(null, nextStakeSize);
            }
        });
    }

    skipNextElections(value) {
        return this.dbOp(cb => {
            if (_.isNil(value)) {
                const skipNextElections = _.get(this.db, 'data.config.skipNextElections', false);

                return cb(null, skipNextElections);
            }
            else {
                const skipNextElections = Boolean(value);

                _.set(this.db, 'data.config.skipNextElections', skipNextElections);

                cb(null, skipNextElections);
            }
        });
    }

    getElectionsInfo(id) {
        return this.dbOp(cb => {
            if (_.isNumber(id)) {
                const result = _
                    .chain(this.db)
                    .get('data.elections')
                    .find({ id })
                    .defaultTo({ id })
                    .value();

                return cb(null, result);
            }
            else {
                const result = _
                    .chain(this.db)
                    .get('data.elections')
                    .defaultTo([])
                    .value();

                return cb(null, result);
            }
        });
    }

    setElectionsInfo(info, incStake = false) {
        return this.dbOp(cb => {
            const id = _.get(info, 'id');

            if (_.isNumber(id)) {
                _.update(this.db, 'data.elections', _.partialRight(_.defaultTo, []));

                const elections = _.get(this.db, 'data.elections');
                const index = _.findLastIndex(elections, { id });

                if (index < 0) {
                    elections.push(info);

                    return cb(null, info);
                }

                if (incStake) {
                    const value = _.get(elections, [index, 'stake'], 0);

                    elections[index] = {
                        ...info,
                        stake: _.add(value, info.stake)
                    }
                }
                else {
                    elections[index] = info;
                }

                return cb(null, elections[index]);
            }
            else {
                return cb(new Error('id is missing'));
            }
        });
    }
}
