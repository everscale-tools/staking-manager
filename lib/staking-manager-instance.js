import mem from 'mem';
import StakingManagerClassBuilder from './staking-manager-class-builder.js';

const get = mem(
    async (config) => {
        const instance = await StakingManagerClassBuilder.build(config).create();

        return instance;
    },
    { cacheKey: JSON.stringify }
);

export default get;

