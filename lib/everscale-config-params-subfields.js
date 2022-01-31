export default {
    // Address of config contract in mc
    p0: '',
    // Address of elector contract in mc
    p1: '',
    // Address of minter contract in mc
    p2: '',
    // Address of fee collector contract in mc
    p3: '',
    // Address of TON DNS root contract in mc
    p4: '',
    // Minter prices
    p6: `{
        mint_new_price
        mint_add_price
    }`,
    // Other Currencies
    p7: `{
        currency
        value
    }`,
    // Global version
    p8: `{
        version
        capabilities
    }`,
    //
    p9: '',
    //
    p10: '',
    // Config voting setup
    p11: `{
        normal_params {
            min_tot_rounds
            max_tot_rounds
            min_wins
            max_losses
            min_store_sec
            max_store_sec
            bit_price
            cell_price
        }
        critical_params {
            min_tot_rounds
            max_tot_rounds
            min_wins
            max_losses
            min_store_sec
            max_store_sec
            bit_price
            cell_price
        }
    }`,
    // Array of all workchain descriptions
    p12: `{
        workchain_id
        enabled_since
        actual_min_split
        min_split
        max_split
        active
        accept_msgs
        flags
        zerostate_root_hash
        zerostate_file_hash
        version
        basic
        vm_version
        vm_mode
        min_addr_len
        max_addr_len
        addr_len_step
        workchain_type_id
    }`,
    // Block create fees
    p14: `{
        masterchain_block_fee
        basechain_block_fee
    }`,
    // Election parameters
    p15: `{
        validators_elected_for
        elections_start_before
        elections_end_before
        stake_held_for
    }`,
    // Validators count
    p16: `{
        max_validators
        max_main_validators
        min_validators
    }`,
    // Validator stake parameters
    p17: `{
        min_stake
        max_stake
        min_total_stake
        max_stake_factor
    }`,
    // Storage prices
    p18: `{
        utime_since
        bit_price_ps
        cell_price_ps
        mc_bit_price_ps
        mc_cell_price_ps
    }`,
    // Gas limits and prices in the masterchain
    p20: `{
        gas_price
        gas_limit
        special_gas_limit
        gas_credit
        block_gas_limit
        freeze_due_limit
        delete_due_limit
        flat_gas_limit
        flat_gas_price
    }`,
    // Gas limits and prices in workchains
    p21: `{
        gas_price
        gas_limit
        special_gas_limit
        gas_credit
        block_gas_limit
        freeze_due_limit
        delete_due_limit
        flat_gas_limit
        flat_gas_price
    }`,
    // Block limits in the masterchain
    p22: `{
        bytes {
            underload
            soft_limit
            hard_limit
        }
        gas {
            underload
            soft_limit
            hard_limit
        }
        lt_delta {
            underload
            soft_limit
            hard_limit
        }
    }`,
    // Block limits in workchains
    p23: `{
        bytes {
            underload
            soft_limit
            hard_limit
        }
        gas {
            underload
            soft_limit
            hard_limit
        }
        lt_delta {
            underload
            soft_limit
            hard_limit
        }
    }`,
    // Message forward prices in the masterchain
    p24: `{
        lump_price
        bit_price
        cell_price
        ihr_price_factor
        first_frac
        next_frac
    }`,
    // Message forward prices in workchains
    p25: `{
        lump_price
        bit_price
        cell_price
        ihr_price_factor
        first_frac
        next_frac
    }`,
    // BlockMasterConfig
    p28: `{
        mc_catchain_lifetime
        shard_catchain_lifetime
        shard_validators_lifetime
        shard_validators_num
    }`,
    // BlockMasterConfig
    p29: `{
        round_candidates
        next_candidate_delay_ms
        consensus_timeout_ms
        fast_attempts
        attempt_duration
        catchain_max_deps
        max_block_bytes
        max_collated_bytes
    }`,
    // Addresses of some service contracts
    p31: '',
    // Previous validators set
    p32: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Previous temporary validators set
    p33: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Current validators set
    p34: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Current temporaty validators set
    p35: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Next validators set
    p36: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Next temporary validators set
    p37: `{
        utime_since
        utime_until
        total
        total_weight
        list {
            public_key
            adnl_addr
            weight
        }
    }`,
    // Array of validators signed temporaty keys
    p39: `{
        adnl_addr
        temp_public_key
        seqno
        valid_until
        signature_r
        signature_s
    }`
};

