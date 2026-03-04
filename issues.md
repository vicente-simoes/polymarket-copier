1. it is buying  positions that  the leader bought a few hours ago even though they are now 20c more expensive than the avg value the leader got them for. - understand what the worker compares currrent share price to when looking at potential open copies (or attempting, not sure)

2. not sure if selling is working properly. need to check.

3. getting guardrails from envs and not from config page (already fixing). i think even after the current fix we will still not have per leader overrides working but at least we will be reading globals from config and not env file.

4. Still not wired from Config page:

minBookDepthForSizeEnabled (no-op)
maxOpenOrders (no-op)

5. Also not switched to Config-page override in worker yet:

Global sizing caps like maxExposurePerLeaderUsd, maxExposurePerMarketOutcomeUsd, maxHourlyNotionalTurnoverUsd, maxDailyNotionalTurnoverUsd (those are not currently profile-config-driven in worker runtime)