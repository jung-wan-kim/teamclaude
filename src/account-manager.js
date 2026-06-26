import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

/** Coerce a per-account / global concurrency cap to a positive integer, else fallback. */
function coerceMaxConcurrent(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, reevalIntervalMs = 5 * 60 * 1000, maxConcurrentDefault = 3, overflowQueueMaxDepth = 256) {
    this.maxConcurrentDefault = coerceMaxConcurrent(maxConcurrentDefault, 3);
    // Hard cap on the overflow queue so a flood of concurrent requests can't grow
    // it (and the buffered bodies / sockets / timers it pins) without bound. Past
    // this depth acquireAccount rejects immediately (→ 429) instead of queuing.
    this.maxQueueDepth = Number.isFinite(overflowQueueMaxDepth) && overflowQueueMaxDepth >= 0
      ? Math.floor(overflowQueueMaxDepth) : 256;
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      // Concurrency: how many requests are in flight through this account right
      // now, and the per-account cap above which the selector treats it as
      // momentarily full (so concurrent load spreads to other accounts).
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acct.maxConcurrent, this.maxConcurrentDefault),
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    this.reevalIntervalMs = reevalIntervalMs;
    this.lastEvalAt = 0; // 0 forces a priority pick on the first request
    this.maxWarmupTries = 3; // give up warming an account after this many unmeasured attempts
    this._warmupCursor = 0;  // round-robin pointer used during warm-up
    this._waiters = [];      // overflow queue: requests waiting for a free slot
    // Soft connection→account affinity (keyed by the client socket). Keeps one
    // keep-alive connection's *sequential* requests on the same account so
    // Anthropic's per-account prompt cache stays warm. A WeakMap so an entry is
    // GC'd when the socket is collected (connection closed) — no manual cleanup,
    // no leak. The stored value is the account *object* (not its index, which
    // shifts on removeAccount); a stale entry is detected and ignored.
    this._affinity = new WeakMap();
  }

  /**
   * Get the account to use for the next request.
   *
   * Policy:
   *  - Cold-start warm-up: while any available account is still unmeasured,
   *    route to it so its quota (usage % / reset) gets populated before any
   *    priority decision is made on incomplete data.
   *  - If the current account is unavailable (near quota / throttled / error),
   *    switch immediately to the highest-priority account. This is the old
   *    "switch at threshold" trigger — but it now picks by priority rather
   *    than round-robin to the next index.
   *  - Otherwise re-evaluate priority at most once per `reevalIntervalMs`
   *    (default 5 min) and switch if a higher-priority account exists. Set
   *    `reevalIntervalMs <= 0` (config `reevalIntervalMs: 0`) to disable this
   *    timer entirely — the account then only changes when it becomes
   *    unavailable or via per-request 429 failover.
   *  - Between re-evaluations the current account is sticky, so a request
   *    stream stays on one account and keeps Anthropic's per-account prompt
   *    cache warm.
   *
   * Priority is "use-or-lose": soonest session reset first, then lowest
   * session usage — so quota about to reset (and otherwise be wasted) is
   * consumed first. Returns null if every account is exhausted.
   */
  getActiveAccount(exclude = null) {
    const now = Date.now();

    // Per-request failover: a prior account already returned a non-quota 429
    // for THIS request (its indexes are in `exclude`). Pick another available
    // account by priority WITHOUT touching the sticky primary or warm-up state
    // — this diverts only the overflow of one request; steady-state selection
    // still prefers the use-or-lose primary, keeping its prompt cache warm.
    // Returns null once every available account has been tried this request.
    if (exclude && exclude.size) return this._selectBest(exclude);

    const current = this.accounts[this.currentIndex];

    // Cold-start warm-up: until every available account has been measured at
    // least once, round-robin across the unmeasured accounts so their quota
    // (usage % / reset) gets populated. Round-robin (not "first unmeasured")
    // means a concurrent startup burst of any size spreads evenly instead of
    // hammering one unknown-quota account. Only once all are measured does the
    // use-or-lose priority below take over — with complete data.
    const warmup = this._nextWarmup();
    if (warmup) {
      if (warmup.index !== this.currentIndex) {
        console.log(`[TeamClaude] Warm-up: measuring account "${warmup.name}"`);
        this.currentIndex = warmup.index;
      }
      return warmup;
    }

    if (!this._isAvailable(current)) {
      const best = this._selectBest();
      if (best) {
        if (best.index !== this.currentIndex) {
          console.log(`[TeamClaude] Switched to account "${best.name}" (current unavailable)`);
        }
        this.currentIndex = best.index;
        this.lastEvalAt = now;
      }
      return best;
    }

    // Periodic re-prioritization. Disabled when reevalIntervalMs <= 0: the
    // current account then stays sticky and only changes when it becomes
    // unavailable (exhausted / throttled / error) or via per-request 429
    // failover — no timer-driven switching.
    if (this.reevalIntervalMs > 0 && now - this.lastEvalAt >= this.reevalIntervalMs) {
      this.lastEvalAt = now;
      const best = this._selectBest();
      if (best && best.index !== this.currentIndex) {
        console.log(`[TeamClaude] Re-prioritized to account "${best.name}" (session resets soonest)`);
        this.currentIndex = best.index;
        return best;
      }
    }

    // While the current account is still unmeasured, keep load-balancing via
    // _selectBest (which rotates among equal-rank accounts) instead of sticking
    // to an unknown-quota account — so a cold-start burst stays spread even
    // after per-account warm-up attempts are exhausted.
    if (!this._isMeasured(current)) {
      const best = this._selectBest();
      if (best) {
        this.currentIndex = best.index;
        return best;
      }
    }

    return current;
  }

  // ── Concurrency layer: per-account in-flight cap + overflow queue ──────────
  //
  // getActiveAccount() above picks ONE account (sticky, use-or-lose). On its own
  // that funnels every concurrent terminal onto the same account, which then hits
  // Anthropic's per-account rate / concurrency limit (429) while other accounts
  // sit idle with quota to spare. The layer below fixes that PROACTIVELY: each
  // account carries an `inflight` counter and a `maxConcurrent` cap, and
  // acquireAccount() treats a capped account as momentarily unavailable (folds it
  // into the exclude set). The existing priority logic then naturally spreads
  // load to the next account — filling A up to its cap, then B, then C, by
  // use-or-lose priority. When every available account is at its cap the request
  // waits briefly for a slot to free (overflow queue) instead of 429-storming.

  /** Has this account a free concurrency slot? */
  _hasCapacity(account) {
    return account.inflight < account.maxConcurrent;
  }

  /** Indexes of available accounts currently at their concurrency cap. */
  _cappedSet(exclude = null) {
    const capped = new Set();
    for (const a of this.accounts) {
      if (exclude && exclude.has(a.index)) continue;
      if (this._isAvailable(a) && !this._hasCapacity(a)) capped.add(a.index);
    }
    return capped;
  }

  /** Is there an available account with a free slot (not excluded)? Non-mutating. */
  anyUsable(exclude = null) {
    return this.accounts.some(a =>
      this._isAvailable(a) && this._hasCapacity(a) && !(exclude && exclude.has(a.index)));
  }

  /** Is there an available-but-capped account (not excluded)? A freed slot could serve it. */
  anyCapped(exclude = null) {
    return this.accounts.some(a =>
      this._isAvailable(a) && !this._hasCapacity(a) && !(exclude && exclude.has(a.index)));
  }

  /**
   * Synchronously pick + reserve the best account that is available AND has a
   * free concurrency slot, honoring `exclude`. Capped accounts are folded into
   * the exclusion so the existing getActiveAccount / _selectBest priority logic
   * (warm-up, use-or-lose, recover) only ever chooses an account that can take
   * the request. Increments the chosen account's inflight. Returns null when
   * nothing is currently acquirable (all exhausted, excluded, or capped).
   *
   * Single-threaded JS keeps this race-free: there is no await between selecting
   * the account and the inflight++ that reserves its slot.
   */
  _tryAcquire(exclude = null, affinityKey = null) {
    // Only an object/function is a valid WeakMap key. Ignore anything else (a
    // primitive key from an external caller would otherwise throw on get/set).
    const affOk = affinityKey != null
      && (typeof affinityKey === 'object' || typeof affinityKey === 'function');

    // Connection affinity (cache locality): prefer the account this connection
    // already used — but only as a *soft* hint, and DEFER to cold-start warm-up.
    // While any account still needs measuring, skip affinity so it can't pin all
    // of a connection's traffic to one account and starve the others of quota
    // data (warm-up round-robins the unmeasured accounts instead). Once measured,
    // affinity is honored only when that account is still available, has a free
    // slot, and isn't excluded for this request; otherwise it falls through to
    // normal selection. So it never exceeds a cap, revives an exhausted account,
    // or disturbs use-or-lose for new connections. (`accounts[idx] === a` rejects
    // a stale entry left by a removeAccount that re-indexed the array.)
    if (affOk && !this.accounts.some(acc => this._isWarmupTarget(acc))) {
      const a = this._affinity.get(affinityKey);
      if (a && this.accounts[a.index] === a && this._isAvailable(a)
          && this._hasCapacity(a) && !(exclude && exclude.has(a.index))) {
        a.inflight++;
        return a;
      }
    }

    const capped = this._cappedSet(exclude);
    const eff = ((exclude && exclude.size) || capped.size)
      ? new Set([...(exclude || []), ...capped])
      : null;
    // eff === null → full sticky / warm-up path (cold start, nothing capped).
    // eff set → getActiveAccount routes to _selectBest(eff), which already skips
    // every excluded + capped account.
    const account = eff ? this.getActiveAccount(eff) : this.getActiveAccount();
    if (account && this._isAvailable(account) && this._hasCapacity(account)
        && !(eff && eff.has(account.index))) {
      account.inflight++;
      // (Re)write affinity ONLY when the connection has no still-usable home.
      // Reaching this fall-through path means we left the home account — but that
      // can be merely transient: the home may be momentarily capped (overflow
      // spill) or failover-excluded for THIS request, yet still perfectly
      // available. Overwriting it then would let one blip permanently evict the
      // connection from its cache-warm account. So keep an available home (even
      // capped/excluded right now); replace it only when it's genuinely gone
      // (removed, unavailable, or exhausted — `_isAvailable` is false).
      if (affOk) {
        const home = this._affinity.get(affinityKey);
        const homeUsable = home && this.accounts[home.index] === home && this._isAvailable(home);
        if (!homeUsable) this._affinity.set(affinityKey, account);
      }
      return account;
    }
    return null;
  }

  /**
   * Acquire an account for a request, reserving one of its concurrency slots.
   * If none is immediately acquirable but an available account is merely at its
   * cap (overflow), wait up to `timeoutMs` for a slot to free — a releaseAccount
   * elsewhere wakes the waiter. Returns null when every account is genuinely
   * unavailable (quota-exhausted / auth-error / excluded) or the wait times out,
   * so the caller surfaces a 429 for the client to back off on.
   *
   * The caller MUST releaseAccount(account.index) exactly once when the request
   * (including any streamed body) finishes.
   */
  async acquireAccount(exclude = null, timeoutMs = 0, signal = null, affinityKey = null) {
    if (signal?.aborted) return null;
    const account = this._tryAcquire(exclude, affinityKey);
    if (account) return account;
    // Queue only when the blockage is cap-saturation (a slot WILL free as
    // in-flight requests finish) AND the queue isn't already full. If no
    // available account exists at all, or the queue is at its depth cap, return
    // null and let the caller 429 — never grow the backlog without bound.
    if (timeoutMs <= 0 || !this.anyCapped(exclude) || this.isQueueFull()) return null;
    return this._enqueue(exclude, timeoutMs, signal, affinityKey);
  }

  /** Is the overflow queue at its depth cap? */
  isQueueFull() {
    return this._waiters.length >= this.maxQueueDepth;
  }

  /** Upper bound on useful concurrent requests: sum of caps + the queue depth. */
  totalCapacity() {
    return this.accounts.reduce((sum, a) => sum + a.maxConcurrent, 0) + this.maxQueueDepth;
  }

  _enqueue(exclude, timeoutMs, signal = null, affinityKey = null) {
    return new Promise(resolve => {
      const waiter = { exclude, resolve, done: false, timer: null, signal, onAbort: null, affinityKey };
      waiter.timer = setTimeout(() => this._settleWaiter(waiter, null), timeoutMs);
      // Cancel the wait if the client disconnects — otherwise an aborted request
      // would still acquire a slot later and be dispatched upstream, burning quota.
      if (signal) {
        waiter.onAbort = () => this._settleWaiter(waiter, null);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this._waiters.push(waiter);
    });
  }

  /** Resolve a queued waiter exactly once, cleaning up its timer/abort listener. */
  _settleWaiter(waiter, value) {
    if (waiter.done) return false;
    waiter.done = true;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    const i = this._waiters.indexOf(waiter);
    if (i >= 0) this._waiters.splice(i, 1);
    waiter.resolve(value);
    return true;
  }

  /**
   * Release a concurrency slot held by a request and hand any freed capacity to
   * the longest-waiting overflow request that can use it (FIFO, but a waiter
   * whose exclude set can't currently be satisfied is skipped rather than
   * head-of-line blocking a later waiter that can run).
   */
  releaseAccount(index) {
    const account = this.accounts[index];
    if (account && account.inflight > 0) account.inflight--;
    this._drainWaiters();
  }

  _drainWaiters() {
    for (let i = 0; i < this._waiters.length;) {
      const waiter = this._waiters[i];
      const account = this._tryAcquire(waiter.exclude, waiter.affinityKey);
      if (!account) { i++; continue; }
      // _settleWaiter splices the waiter out, so don't advance i. If it was
      // already settled (shouldn't happen — settled waiters aren't in the list),
      // give the slot back instead of leaking it.
      if (!this._settleWaiter(waiter, account)) { account.inflight--; i++; }
    }
  }

  /**
   * Highest-priority available account by use-or-lose ordering: soonest
   * session reset first, then lowest session utilization. Falls back to the
   * soonest-resetting account when none are currently available.
   *
   * `exclude` (a Set of indexes) is used for per-request failover: those
   * accounts are skipped, and when nothing else is eligible this returns null
   * (instead of recovering one) so the caller can pass the 429 through.
   */
  _selectBest(exclude = null) {
    const has = i => (exclude ? exclude.has(i) : false);
    const eligible = this.accounts.filter(a => this._isAvailable(a) && !has(a.index));
    if (eligible.length === 0) return exclude ? null : this._recoverSoonest();

    eligible.sort((a, b) => {
      const ra = this._sessionResetTime(a);
      const rb = this._sessionResetTime(b);
      if (ra !== rb) return ra - rb;                                     // soonest reset first
      return this._sessionUtilization(a) - this._sessionUtilization(b);  // then least used
    });

    // Accounts tied for the best rank (notably all-unknown at cold start) are
    // load-balanced round-robin instead of always pinning to the lowest index,
    // so a startup burst can't pile onto one account before quotas are known.
    const r0 = this._sessionResetTime(eligible[0]);
    const u0 = this._sessionUtilization(eligible[0]);
    const tied = eligible
      .filter(a => this._sessionResetTime(a) === r0 && this._sessionUtilization(a) === u0)
      .sort((a, b) => a.index - b.index);
    if (tied.length <= 1) return eligible[0];
    return tied.find(a => a.index > this.currentIndex) || tied[0];
  }

  /** Session reset timestamp (ms): unified 5h (Max) → standard reset → Infinity. */
  _sessionResetTime(account) {
    const q = account.quota;
    if (q.unified5hReset) return q.unified5hReset;
    if (q.resetsAt) return new Date(q.resetsAt).getTime();
    return Infinity;
  }

  /** Session utilization 0–1: unified 5h (Max) → standard token/request usage → 0. */
  _sessionUtilization(account) {
    const q = account.quota;
    if (q.unified5h != null) return q.unified5h;
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      return 1 - q.tokensRemaining / q.tokensLimit;
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      return 1 - q.requestsRemaining / q.requestsLimit;
    }
    return 0;
  }

  /** True once we have any quota data for this account (rate-limit headers seen). */
  _isMeasured(account) {
    const q = account.quota;
    return q.unified5h != null || q.unified7d != null
      || q.tokensLimit != null || q.requestsLimit != null;
  }

  /**
   * An account still needing warm-up: available, not yet MEASURED, under the
   * per-account attempt cap.
   *
   * Keying on `!_isMeasured` (not on "has it made a request") is deliberate: a
   * request can return *no* rate-limit headers — a `HEAD /` health check, a
   * 404, an auth failure — which would leave the account unmeasured. Gating
   * warm-up on `totalRequests === 0` used to permanently disqualify such an
   * account after that single header-less request, trapping it as "unmeasured"
   * forever: it then sorts to the bottom of use-or-lose priority (no reset
   * data) and the unmeasured-rebalance bounces any switch away from it, so it
   * never gets used again — and its token never gets refreshed, so it expires.
   *
   * maxWarmupTries provides the loop-safety instead: a genuinely dead account
   * (always header-less / 401) is abandoned after a few attempts rather than
   * looping forever. (An expired-token account is resolved on its first warm-up
   * routing anyway — ensureTokenFresh either refreshes it into a measurable
   * state or marks it `error`, which makes it unavailable here.)
   */
  _isWarmupTarget(account) {
    return this._isAvailable(account)
      && !this._isMeasured(account)
      && (account._warmupTries || 0) < this.maxWarmupTries;
  }

  /**
   * Next account to warm up, round-robin across the warm-up targets so a burst
   * spreads evenly. Advances the cursor and bumps the chosen account's attempt
   * counter synchronously, so concurrent calls pick different accounts even
   * before any response arrives. Returns null when no target remains.
   */
  _nextWarmup() {
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const idx = (this._warmupCursor + i) % n;
      const a = this.accounts[idx];
      if (this._isWarmupTarget(a)) {
        this._warmupCursor = idx + 1;
        a._warmupTries = (a._warmupTries || 0) + 1;
        return a;
      }
    }
    return null;
  }

  _isAvailable(account) {
    if (!account) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    return true;
  }

  _isNearQuota(account) {
    const q = account.quota;
    const now = Date.now();

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
    }

    // Unified quotas (Claude Max) — utilization is already 0-1
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  /** When all accounts are unavailable, return the soonest to reset (if it has already reset). */
  _recoverSoonest() {
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Does a 429 from this account indicate genuine *account-level quota
   * exhaustion* (vs a transient / global / IP / request-level 429)?
   *
   * Only exhaustion 429s should throttle the account and trigger a switch to
   * another account. A non-exhaustion 429 must NOT be replayed across the
   * fleet — otherwise a single request whose 429 is request-global (e.g. a
   * malformed request, an org/IP limit, or a momentary upstream blip) would
   * poison every account and make unrelated requests fail too.
   *
   * Call this *after* updateQuota() has folded the 429's rate-limit headers
   * into the account's quota state.
   */
  isExhausted(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return false;
    // Claude Max: upstream explicitly rejects when over the unified limit.
    if (account.quota.unifiedStatus === 'rejected') return true;
    // Otherwise rely on measured utilization (unified or standard headers).
    return this._isNearQuota(account);
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acctData.maxConcurrent, this.maxConcurrentDefault),
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        inflight: a.inflight,
        maxConcurrent: a.maxConcurrent,
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
