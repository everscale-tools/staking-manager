import _ from 'lodash';
import Debug from 'debug';
import express from 'express';
import asyncHandler from 'express-async-handler';
import getStakingManagerInstance from '../lib/staking-manager-instance.js';
import * as config from '../config.js';

const debug = Debug('api');
const router = express.Router();

export default router;

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
        return { stake: 0, weight: 0 }
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
    }
}

router.post('/stake/:action', asyncHandler(async (req, res) => {
    const stakingManager = getStakingManagerInstance();

    switch(req.params.action) {
        case 'send': {
            const force = _.some(['yes', 'true', '1'], v => v === _.toLower(req.query.force));

            await stakingManager.sendStake(!force);
        } break;
        case 'recover': {
            await stakingManager.recoverStake();
        } break;
        case 'resize': {
            await stakingManager.setNextStakeSize(_.toInteger(req.query.value));
        } break;
        default: {
            const err = new Error('action isn\'t "send", "recover" nor "resize"');

            err.statusCode = 400;

            throw err;
        }
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
        default: {
            const err = new Error('action is neither "skip" nor "participate"');

            err.statusCode = 400;

            throw err;
        }
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
        default: {
            const err = new Error('target is neither "history" nor "participants"');

            err.statusCode = 400;

            throw err;
        }
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
