# Summary of Changes

## 5.0.0
- wallet-based staking: stake size is managed automatically, manual resizing is no more
- webhooks for notifications and/or alarms
  - on elections participation confirmed
  - on elections participation is not confirmed for too long
  - on the node getting out of sync
  - on stake sending failed
- huge part of the configuration settings got default values and made optional
- refactoring: migration from CJS to ESM
- a few minor bugs got fixed

## 4.1.0
- reliability improvements
- logging improvements
- config.js example updated

## 4.0.0
- 'legacy' policy isn't supported anymore due to deprecation of C++ Node
- usage of legacy tools, including fift, got rid of
- transactions might be submitted via Rust Node Console
- BREAKING(config): some fields are renamed/deleted - refer to config.js.example for guidance

## 3.3.1
- TONOS SDK updated to 1.27.1

## 3.3.0
- 'modern' policy doesn't rely on Elector ABI

## 3.2.1
- timediff extraction failure isn't fatal anymore

## 3.2.0
- ticktock sending implementation re-designed
- timediff extraction re-designed
- config.js example updated

## 3.1.1
- wrong 'create_at' value in DePool events lookup got fixed

## 3.1.0
- additional call to ticktock is introduced

## 3.0.0
- Stake sending cannot be initiated if it's already in progress
- Stake made via DePool is ensured to be either accepted or rejected
- BREAKING(config): API Servers are now being specified as a part of a full-fledged TONOS config
- BREAKING(api): `/ticktock` became `PUT` instead of `GET`
- minor fixes and improvements

## 2.0.0
- Rust Node/Net support
- jwt-based authentication for admin
- significant refactoring, additional error handling and other minor improvements

## 1.7.0
- moved to the newest SDK version (@tonclient/core 1.2.1)

## 1.6.0
- 'ticktock' request got accessible through HTTP API
- a few fixes, including one related to DePool contract update

## 1.5.0
- DePool staking doesn't depend on Helper smart contract anymore

## 1.4.0
- DePool staking made timer-compatible (past events are checked for the Proxy address first)
- minor fixes

## 1.3.0
- 'depool' funding mode: stakes might be sent from DePool instead of a wallet

## 1.2.0
- 'native' mode: __lite-client__ might be used for submitting transactions

## 1.1.1
- minor fixes
