import _ from 'lodash';
import Debug from 'debug';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import logger from 'morgan';
import { CronJob } from 'cron';
import { unless } from 'express-unless';
import { serializeError } from 'serialize-error';
import getStakingManagerInstance from './lib/staking-manager-instance.js';
import apiRouter from './routes/api.js';
import config from './config.js';

const debug = Debug('app');
const app = express();
const port = 3000;
const stakingManager = await getStakingManagerInstance(config);

app.set('port', port);
app.use(logger('dev', {
    skip: (req, res) => _.startsWith(req.originalUrl, '/stats') && res.statusCode < 400
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function protectRoute(secret) {
    const middleware = (req, res, next) => {
        const token = req.header('EVERSCALE-SM-APIKEY');

        if (_.isEmpty(token)) {
            return res.status(401).send('error: token is not provided');
        }

        return jwt.verify(token, secret, { algorithms: ['HS256'] }, (err, decoded) => {
            if (err) {
                debug(err);

                return res.status(500).send('error: token verification failed');
            }

            const misfits = [
                process.env.EVERSCALE_SM_ADMIN_NAME !== decoded.name,
                process.env.EVERSCALE_SM_ADMIN_PASSWORD !== decoded.password
            ];

            if (_.some(misfits)) {
                return res.status(401).send();
            }

            return next();
        });
    };

    middleware.unless = unless;

    return middleware;
}

const secret = process.env.EVERSCALE_SM_AUTH_SECRET;

if (! _.isEmpty(secret)) {
    app.use(protectRoute(secret).unless({ path: ['/auth', /\/stats*/] }));

    apiRouter.post('/auth', (req, res) => {
        const misfits = [
            _.isEmpty(process.env.EVERSCALE_SM_ADMIN_NAME),
            _.isEmpty(process.env.EVERSCALE_SM_ADMIN_PASSWORD),
            _.isEmpty(req.body.name),
            _.isEmpty(req.body.password),
            process.env.EVERSCALE_SM_ADMIN_NAME !== req.body.name,
            process.env.EVERSCALE_SM_ADMIN_PASSWORD !== req.body.password
        ];

        if (_.some(misfits)) {
            return res.status(401).send('error: login/password ain\'t set/provided/valid');
        }

        const token = jwt.sign(
            _.pick(req.body, ['name', 'password']),
            secret,
            { algorithm: 'HS256', noTimestamp: true });

        return res.send(token);
    });
}

app.use('/', apiRouter);

async function getTimeDiffOr(defaultValue) {
    try {
        const timeDiff = await stakingManager.getTimeDiff();

        return timeDiff;
    }
    catch (err) {
        debug('INFO: timeDiff getting failed - the check will be skipped');

        return defaultValue;
    }
}

function createJobFn(fnName) {
    return async () => {
        try {
            const {
                enabled: periodicJobsEnabled,
                acceptableTimeDiff: threshold
            } = await stakingManager.getPeriodicJobsSettings();

            if (!periodicJobsEnabled) {
                return;
            }

            const timeDiff = await getTimeDiffOr(0);

            if (Math.abs(timeDiff) > Math.abs(threshold)) {
                debug(`WARN: job's canceled due to unacceptable TIME_DIFF (exceeding a threshold of ${threshold})`);

                _.invoke(stakingManager, 'sendNotification', {
                    event: 'TIMEDIFF_EXCEEDS_THRESHOLD',
                    context: {
                        value: timeDiff,
                        threshold
                    }
                });

                return;
            }

            await _.invoke(stakingManager, fnName);
        }
        catch (err) {
            debug('ERROR:', JSON.stringify(serializeError(err), null, 2));
        }
    };
}

async function runJobs() {
    const { sendStake: schedule } = await stakingManager.getPeriodicJobsSettings();
    const stakeSendingJob = new CronJob(schedule, createJobFn('sendStake'));

    stakeSendingJob.start();
}

await runJobs();

const server = http.createServer(app);

server.setTimeout(600000);
server.on('error', (err) => {
    debug(err);

    process.exit(1);
});
server.on('listening', () => {
    const addr = server.address();
    const bind = _.isString(addr)
        ? 'pipe ' + addr
        : 'port ' + addr.port;

    debug('listening on ' + bind);
});
server.listen(port);
