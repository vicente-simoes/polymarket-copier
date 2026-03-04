import { copyDecisionKey } from "@copybot/shared";
import type {
  ActiveCopyProfile,
  PendingDeltaSide,
  PendingDeltaStatus,
  PriceSnapshot,
  TargetNettingConfig,
  TargetNettingStatus,
  TargetNettingStore
} from "./types.js";

export interface TargetNettingEngineDeps {
  store: TargetNettingStore;
  config: TargetNettingConfig;
  resolvePriceSnapshot: (tokenId: string, marketId?: string) => Promise<PriceSnapshot | null>;
  now?: () => number;
}

export class TargetNettingEngine {
  private readonly store: TargetNettingStore;
  private readonly config: TargetNettingConfig;
  private readonly resolvePriceSnapshot: (tokenId: string, marketId?: string) => Promise<PriceSnapshot | null>;
  private readonly now: () => number;
  private interval?: NodeJS.Timeout;
  private inFlight = false;
  private readonly status: TargetNettingStatus;

  constructor(deps: TargetNettingEngineDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.resolvePriceSnapshot = deps.resolvePriceSnapshot;
    this.now = deps.now ?? Date.now;
    this.status = {
      enabled: deps.config.enabled,
      running: false,
      totalRuns: 0,
      totalFailures: 0,
      lastProfilesProcessed: 0,
      lastTokensEvaluated: 0,
      lastPendingUpdated: 0,
      lastAttemptsCreated: 0
    };
  }

  start(): void {
    this.status.enabled = this.config.enabled;
    if (!this.config.enabled) {
      return;
    }
    if (this.interval) {
      return;
    }

    this.startInterval();

    void this.run();
  }

  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) {
      this.status.enabled = enabled;
      return;
    }

    this.config.enabled = enabled;
    this.status.enabled = enabled;
    if (enabled) {
      this.start();
      return;
    }

    this.stop();
  }

  setIntervalMs(intervalMs: number): void {
    const normalized = Math.max(1000, Math.trunc(intervalMs));
    if (this.config.intervalMs === normalized) {
      return;
    }

    this.config.intervalMs = normalized;
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.startInterval();
  }

  setTrackingErrorBps(trackingErrorBps: number): void {
    const normalized = Math.max(0, Math.trunc(trackingErrorBps));
    this.config.trackingErrorBps = normalized;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.status.running = false;
  }

  private startInterval(): void {
    this.interval = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);
  }

  getStatus(): TargetNettingStatus {
    return {
      ...this.status
    };
  }

  async run(): Promise<void> {
    if (!this.config.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    this.status.running = true;
    this.status.totalRuns += 1;
    this.status.lastRunAtMs = this.now();
    const startedAtMs = this.now();

    let profilesProcessed = 0;
    let tokensEvaluated = 0;
    let pendingUpdated = 0;
    let attemptsCreated = 0;

    try {
      const profiles = await this.store.listActiveCopyProfiles();
      for (const profile of profiles) {
        const outcome = await this.runProfile(profile);
        profilesProcessed += 1;
        tokensEvaluated += outcome.tokensEvaluated;
        pendingUpdated += outcome.pendingUpdated;
        attemptsCreated += outcome.attemptsCreated;
      }

      this.status.lastSuccessAtMs = this.now();
      this.status.lastError = undefined;
    } catch (error) {
      this.status.totalFailures += 1;
      this.status.lastFailureAtMs = this.now();
      this.status.lastError = toErrorMessage(error);
    } finally {
      this.status.running = false;
      this.status.lastDurationMs = this.now() - startedAtMs;
      this.status.lastProfilesProcessed = profilesProcessed;
      this.status.lastTokensEvaluated = tokensEvaluated;
      this.status.lastPendingUpdated = pendingUpdated;
      this.status.lastAttemptsCreated = attemptsCreated;
      this.inFlight = false;
    }
  }

  private async runProfile(profile: ActiveCopyProfile): Promise<{
    tokensEvaluated: number;
    pendingUpdated: number;
    attemptsCreated: number;
  }> {
    const effectiveMinNotionalUsd = profile.guardrailOverrides?.minNotionalUsd ?? this.config.minNotionalUsd;
    const effectiveMaxRetriesPerAttempt =
      profile.guardrailOverrides?.maxRetriesPerAttempt ?? this.config.maxRetriesPerAttempt;
    const effectiveAttemptExpirationSeconds =
      profile.guardrailOverrides?.attemptExpirationSeconds ?? this.config.attemptExpirationSeconds;

    const leaderIds = [...new Set(profile.leaders.map((leader) => leader.leaderId))];
    if (leaderIds.length === 0) {
      return {
        tokensEvaluated: 0,
        pendingUpdated: 0,
        attemptsCreated: 0
      };
    }

    const [leaderPositions, followerPositions, openPendingTokenIds] = await Promise.all([
      this.store.getLatestLeaderPositions(leaderIds),
      this.store.getLatestFollowerPositions(profile.copyProfileId),
      this.store.listOpenPendingTokenIds(profile.copyProfileId)
    ]);

    const ratioByLeader = new Map(profile.leaders.map((leader) => [leader.leaderId, leader.ratio]));
    const settingsByLeader = new Map(profile.leaders.map((leader) => [leader.leaderId, leader.settings]));
    const followerSharesByToken = new Map(followerPositions.map((position) => [position.tokenId, position.shares]));
    const targetSharesByToken = new Map<string, number>();
    const targetMarketByToken = new Map<string, string | undefined>();
    const targetPriceByToken = new Map<string, { price: number; source: string; minOrderSize: number }>();
    const leaderBreakdownByToken = new Map<string, Record<string, number>>();
    const contributorLeaderIdsByToken = new Map<string, Set<string>>();
    const strictestMinNotionalByToken = new Map<string, number>();

    for (const position of leaderPositions) {
      const ratio = ratioByLeader.get(position.leaderId);
      if (ratio === undefined || ratio <= 0) {
        continue;
      }
      const leaderSettings = settingsByLeader.get(position.leaderId);
      if (!leaderSettings) {
        continue;
      }
      if (!isMarketAllowed(position.marketId, leaderSettings.allowList, leaderSettings.denyList)) {
        continue;
      }

      const priceSnapshot = await this.resolvePriceSnapshot(position.tokenId, position.marketId);
      const chosenPrice = choosePrice(position.currentPrice, priceSnapshot);
      if (!chosenPrice || chosenPrice <= 0) {
        continue;
      }

      const currentValueUsd =
        position.currentValueUsd !== undefined && position.currentValueUsd > 0
          ? position.currentValueUsd
          : position.shares * chosenPrice;
      if (currentValueUsd <= 0) {
        continue;
      }

      const targetNotionalUsd = currentValueUsd * ratio;
      const targetShares = targetNotionalUsd / chosenPrice;
      if (!isContributionEligible(targetNotionalUsd, targetShares, leaderSettings.minDeltaNotionalUsd, leaderSettings.minDeltaShares)) {
        continue;
      }
      const existingTarget = targetSharesByToken.get(position.tokenId) ?? 0;
      targetSharesByToken.set(position.tokenId, existingTarget + targetShares);

      if (!targetMarketByToken.has(position.tokenId)) {
        targetMarketByToken.set(position.tokenId, position.marketId);
      }

      const resolvedMinOrderSize = normalizeMinOrderSize(priceSnapshot?.minOrderSize);
      targetPriceByToken.set(position.tokenId, {
        price: chosenPrice,
        source: position.currentPrice && position.currentPrice > 0 ? "CUR_PRICE" : (priceSnapshot?.source ?? "UNKNOWN"),
        minOrderSize: resolvedMinOrderSize
      });

      const breakdown = leaderBreakdownByToken.get(position.tokenId) ?? {};
      breakdown[position.leaderId] = (breakdown[position.leaderId] ?? 0) + targetShares;
      leaderBreakdownByToken.set(position.tokenId, breakdown);

      const contributors = contributorLeaderIdsByToken.get(position.tokenId) ?? new Set<string>();
      contributors.add(position.leaderId);
      contributorLeaderIdsByToken.set(position.tokenId, contributors);

      if (leaderSettings.minNotionalPerOrderUsd !== undefined) {
        const existingMin = strictestMinNotionalByToken.get(position.tokenId);
        const nextMin =
          existingMin === undefined
            ? leaderSettings.minNotionalPerOrderUsd
            : Math.max(existingMin, leaderSettings.minNotionalPerOrderUsd);
        strictestMinNotionalByToken.set(position.tokenId, nextMin);
      }
    }

    const tokenUniverse = new Set<string>([...targetSharesByToken.keys(), ...followerSharesByToken.keys(), ...openPendingTokenIds]);
    let pendingUpdated = 0;
    let attemptsCreated = 0;

    for (const tokenId of tokenUniverse) {
      const targetShares = targetSharesByToken.get(tokenId) ?? 0;
      const followerShares = followerSharesByToken.get(tokenId) ?? 0;
      const deltaShares = targetShares - followerShares;

      if (Math.abs(deltaShares) < 1e-12) {
        await this.store.clearTokenPendingDeltas(profile.copyProfileId, tokenId);
        continue;
      }

      const side: PendingDeltaSide = deltaShares > 0 ? "BUY" : "SELL";
      const absoluteDeltaShares = Math.abs(deltaShares);
      const marketId = targetMarketByToken.get(tokenId);
      const primaryLeaderId = resolvePrimaryLeaderId(leaderBreakdownByToken.get(tokenId));
      const contributorLeaderIds = [...(contributorLeaderIdsByToken.get(tokenId) ?? new Set<string>())].sort();
      const effectiveTokenMinNotionalUsd = strictestMinNotionalByToken.get(tokenId) ?? effectiveMinNotionalUsd;

      let tokenPrice = targetPriceByToken.get(tokenId)?.price;
      let priceSource = targetPriceByToken.get(tokenId)?.source ?? "UNKNOWN";
      let minOrderSize = targetPriceByToken.get(tokenId)?.minOrderSize ?? 0;
      if (!tokenPrice || tokenPrice <= 0) {
        const snapshot = await this.resolvePriceSnapshot(tokenId, marketId);
        const fallbackPrice = choosePrice(undefined, snapshot);
        if (!fallbackPrice || fallbackPrice <= 0) {
          continue;
        }

        tokenPrice = fallbackPrice;
        priceSource = snapshot?.source ?? "UNKNOWN";
        minOrderSize = normalizeMinOrderSize(snapshot?.minOrderSize);
      }

      const deltaNotionalUsd = absoluteDeltaShares * tokenPrice;
      const trackingErrorBps = computeTrackingErrorBps(targetShares, followerShares, deltaShares);
      const thresholdResult = evaluateThresholds({
        deltaNotionalUsd,
        minNotionalUsd: effectiveTokenMinNotionalUsd,
        trackingErrorBps,
        requiredTrackingErrorBps: this.config.trackingErrorBps
      });

      const pendingStatus: PendingDeltaStatus = thresholdResult.eligible
        ? "ELIGIBLE"
        : thresholdResult.reason === "UNKNOWN"
          ? "BLOCKED"
          : "PENDING";

      const pending = await this.store.upsertPendingDelta({
        copyProfileId: profile.copyProfileId,
        leaderId: primaryLeaderId,
        tokenId,
        marketId,
        side,
        pendingDeltaShares: absoluteDeltaShares,
        pendingDeltaNotionalUsd: deltaNotionalUsd,
        minExecutableNotionalUsd: effectiveTokenMinNotionalUsd,
        status: pendingStatus,
        blockReason: thresholdResult.reason,
        metadata: {
          targetShares,
          followerShares,
          deltaShares,
          deltaNotionalUsd,
          tokenPrice,
          priceSource,
          minOrderSize,
          trackingErrorBps,
          requiredTrackingErrorBps: this.config.trackingErrorBps,
          thresholdEligible: thresholdResult.eligible,
          thresholdReason: thresholdResult.reason ?? null,
          leaderTargetShares: leaderBreakdownByToken.get(tokenId) ?? {},
          contributorLeaderIds,
          effectiveMinNotionalUsd: effectiveTokenMinNotionalUsd
        },
        expiresAt: new Date(this.now() + effectiveAttemptExpirationSeconds * 1000)
      });

      pendingUpdated += 1;
      await this.store.expireOppositePendingDeltas(profile.copyProfileId, tokenId, side);

      if (!thresholdResult.eligible) {
        continue;
      }

      const existingAttempt = await this.store.findOpenCopyAttemptForPendingDelta(pending.id);
      if (existingAttempt) {
        continue;
      }

      await this.store.createCopyAttempt({
        copyProfileId: profile.copyProfileId,
        leaderId: primaryLeaderId,
        pendingDeltaId: pending.id,
        tokenId,
        marketId,
        side,
        pendingDeltaShares: absoluteDeltaShares,
        pendingDeltaNotionalUsd: deltaNotionalUsd,
        expiresAt: new Date(this.now() + effectiveAttemptExpirationSeconds * 1000),
        maxRetries: effectiveMaxRetriesPerAttempt,
        idempotencyKey: copyDecisionKey({
          copyProfileId: profile.copyProfileId,
          tokenId,
          side,
          pendingDeltaId: pending.id,
          pendingDeltaShares: roundTo(absoluteDeltaShares, 8),
          pendingDeltaNotionalUsd: roundTo(deltaNotionalUsd, 8),
          decisionAtMs: this.now()
        })
      });
      attemptsCreated += 1;
    }

    return {
      tokensEvaluated: tokenUniverse.size,
      pendingUpdated,
      attemptsCreated
    };
  }
}

function choosePrice(currentPrice: number | undefined, snapshot: PriceSnapshot | null): number | undefined {
  if (currentPrice !== undefined && currentPrice > 0) {
    return currentPrice;
  }

  if (!snapshot) {
    return undefined;
  }

  if (snapshot.midPrice !== undefined && snapshot.midPrice > 0) {
    return snapshot.midPrice;
  }

  if (snapshot.topOfBookPrice !== undefined && snapshot.topOfBookPrice > 0) {
    return snapshot.topOfBookPrice;
  }

  return undefined;
}

function normalizeMinOrderSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function computeTrackingErrorBps(targetShares: number, followerShares: number, deltaShares: number): number {
  const denominator = Math.max(Math.abs(targetShares), Math.abs(followerShares), 1e-9);
  return (Math.abs(deltaShares) / denominator) * 10_000;
}

function evaluateThresholds(args: {
  deltaNotionalUsd: number;
  minNotionalUsd: number;
  trackingErrorBps: number;
  requiredTrackingErrorBps: number;
}): { eligible: boolean; reason?: "MIN_NOTIONAL" | "MIN_ORDER_SIZE" | "UNKNOWN" } {
  if (args.deltaNotionalUsd < args.minNotionalUsd) {
    return {
      eligible: false,
      reason: "MIN_NOTIONAL"
    };
  }

  if (args.requiredTrackingErrorBps > 0 && args.trackingErrorBps < args.requiredTrackingErrorBps) {
    return {
      eligible: false,
      reason: "UNKNOWN"
    };
  }

  return {
    eligible: true
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function resolvePrimaryLeaderId(leaderShares: Record<string, number> | undefined): string | undefined {
  if (!leaderShares) {
    return undefined;
  }

  let bestLeaderId: string | undefined;
  let bestShares = 0;

  for (const [leaderId, shares] of Object.entries(leaderShares)) {
    if (!Number.isFinite(shares) || shares <= bestShares) {
      continue;
    }
    bestLeaderId = leaderId;
    bestShares = shares;
  }

  return bestLeaderId;
}

function isMarketAllowed(
  marketId: string | undefined,
  allowList: string[] | undefined,
  denyList: string[] | undefined
): boolean {
  if (marketId && denyList && denyList.includes(marketId)) {
    return false;
  }

  if (!allowList || allowList.length === 0) {
    return true;
  }

  if (!marketId) {
    return false;
  }

  return allowList.includes(marketId);
}

function isContributionEligible(
  targetNotionalUsd: number,
  targetShares: number,
  minDeltaNotionalUsd: number | undefined,
  minDeltaShares: number | undefined
): boolean {
  if (minDeltaNotionalUsd === undefined && minDeltaShares === undefined) {
    return true;
  }

  const absNotional = Math.abs(targetNotionalUsd);
  const absShares = Math.abs(targetShares);
  const notionalEligible = minDeltaNotionalUsd !== undefined ? absNotional >= minDeltaNotionalUsd : false;
  const sharesEligible = minDeltaShares !== undefined ? absShares >= minDeltaShares : false;
  return notionalEligible || sharesEligible;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
