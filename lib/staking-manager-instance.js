import StakingManagerClassBuilder from './staking-manager-class-builder.js';
import * as config from '../config.js';

const instance = await StakingManagerClassBuilder.build(config).create();

export default function get() {
    return instance;
}

