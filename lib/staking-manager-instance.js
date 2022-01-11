import StakingManager from './staking-manager.js';

const instance = await StakingManager.create();

export default function get() {
    return instance;
}
