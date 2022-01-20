import _ from 'lodash';
import Debug from 'debug';
import express from 'express';
import asyncHandler from 'express-async-handler';
import getStakingManagerInstance from '../lib/staking-manager-instance.js';
import * as config from '../config.js';

const debug = Debug('api');
const router = express.Router();

export default router;

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    debug('ERROR:', err);

    res.status(err.statusCode || 500).send();
}

const getLatestStakeAndWeightThrottled = _.throttle(async () => {
    const stakingManager = getStakingManagerInstance();

    try {
        return await stakingManager.getLatestStakeAndWeight();
    }
    catch (err) {
        return { stake: 0, weight: 0 };
    }
}, 300000);
const getWalletBalanceThrottled = _.throttle(async () => {
    const stakingManager = getStakingManagerInstance();

    return stakingManager.getWalletBalance();
}, 300000);

async function getStats(interval) {
    const stakingManager = getStakingManagerInstance();
    const blocksSignatures = await stakingManager.countBlocksSignatures(interval);
    const { stake, weight } = await getLatestStakeAndWeightThrottled();
    const timeDiff = await stakingManager.getTimeDiff();
    const walletBalance = await getWalletBalanceThrottled();

    return {
        blocksSignatures,
        stake,
        weight,
        timeDiff,
        walletBalance
    };
}

class BadRequest extends Error {
    constructor(message) {
        super(message);

        this.statusCode = 400;
    }
}

router.post('/stake/:action', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    switch(req.params.action) {
    case 'send': {
        await stakingManager.sendStake();
    } break;
    case 'recover': {
        await stakingManager.recoverStake();
    } break;
    default: throw new BadRequest('action is neither "send" nor "recover"');
    }

    res.send();
}), errorHandler);

router.post('/elections/:action', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    switch(req.params.action) {
    case 'skip': {
        await stakingManager.skipNextElections(true);
    } break;
    case 'participate': {
        await stakingManager.skipNextElections(false);
    } break;
    default: throw new BadRequest('action is neither "skip" nor "participate"');
    }

    res.send();
}), errorHandler);

router.get('/elections/:target', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    let result;

    switch (req.params.target) {
    case 'history': {
        result = await stakingManager.getElectionsHistory();
    } break;
    case 'participants': {
        result = await stakingManager.getParticipantListExtended();
    } break;
    default: throw new BadRequest('target is neither "history" nor "participants"');
    }

    res.json(result);
}), errorHandler);

router.get('/validation/status', asyncHandler(async (req, res) => {
    // TODO: add some meat

    res.send();
}), errorHandler);

router.post('/validation/resume', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    await stakingManager.restoreKeys();

    res.send();
}), errorHandler);

router.get('/stats/:representation', asyncHandler(async (req, res) => {
    const result = await getStats(
        _.chain(req.query.interval).defaultTo(60).toInteger().value()
    );

    switch (req.params.representation) {
    case 'json': {
        res.json(result);
    } break;
    case 'influxdb': {
        const fields = _
            .chain(result)
            .toPairs()
            .map(([k, v]) => `${_.snakeCase(k)}=${v}`)
            .join()
            .value();

        res.send(`everscale-validator,host=${_.get(config, 'stats.influxdb.host', 'localhost')} ${fields}`);
    } break;
    default: {
        const err = new Error('representation must be either \'json\' or \'influxdb\'');

        err.statusCode = 404;

        throw err;
    }
    }
}), errorHandler);

router.put('/ticktock', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    await stakingManager.sendTicktock();

    res.send();
}), errorHandler);

