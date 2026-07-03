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
    // Model-scoped weekly windows, keyed by header window label — e.g. `7d_oi`,
    // the separate weekly limit for the top model tier shown as "Fable" in
    // Claude's usage UI. Parsed generically from
    // anthropic-ratelimit-unified-<window>-* so a renamed/added window keeps
    // being tracked without a code change. Display-only: it never feeds
    // availability, because an account over its Fable weekly limit still
    // serves every other model.
    modelWeekly: {},       // { '7d_oi': { utilization: 0-1, reset: msTimestamp } }
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
      // Manual on/off switch. A disabled account is excluded from ALL rotation
      // (warm-up, use-or-lose selection, recover, acquire) via _isAvailable —
      // in-flight requests still drain, but no new request is routed to it.
      // Defaults to enabled; only an explicit `enabled: false` disables it.
      enabled: acct.enabled !== false,
      // Explicit selection priority: lower number = preferred first. Null/unset
      // means "no preference" — selection then falls back to use-or-lose. So a
      // config with no priorities behaves exactly as before.
      priority: Number.isFinite(acct.priority) ? Math.floor(acct.priority) : null,
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
   * Priority is "use-or-lose": soonest WEEKLY (7d) reset first, then soonest
   * session reset, then lowest session usage — so quota about to reset (and
   * otherwise be wasted) is consumed first, starting with the scarcer weekly
   * window. Returns null if every account is exhausted.
   */
  getActiveAccount(exclude = null) {
    const now = Date.now();

    // Per-request failover: a prior account already returned a non-quota 429
    // for THIS request (those accounts are in `exclude`, a Set of objects). Pick another available
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
        console.log(`[TeamClaude] Re-prioritized to account "${best.name}" (weekly reset soonest)`);
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

  /**
   * Resolve an account handle to the live account object. Accepts the object
   * itself (reindex-safe — what server.js passes) or a numeric index (legacy /
   * tests). All public per-account methods route their first arg through this so
   * a stale index captured before a removeAccount() can't hit the wrong account.
   */
  _resolve(accountOrIndex) {
    return typeof accountOrIndex === 'number' ? this.accounts[accountOrIndex] : accountOrIndex;
  }

  /**
   * Available accounts currently at their concurrency cap, as a Set of account
   * OBJECTS (not indexes). Object identity is stable across a removeAccount()
   * re-index, so an exclude/capped set captured before the request awaits
   * upstream can't later point at the wrong account.
   */
  _cappedSet(exclude = null) {
    const capped = new Set();
    for (const a of this.accounts) {
      if (exclude && exclude.has(a)) continue;
      if (this._isAvailable(a) && !this._hasCapacity(a)) capped.add(a);
    }
    return capped;
  }

  /** Is there an available account with a free slot (not excluded)? Non-mutating. (`exclude` = Set of account objects.) */
  anyUsable(exclude = null) {
    return this.accounts.some(a =>
      this._isAvailable(a) && this._hasCapacity(a) && !(exclude && exclude.has(a)));
  }

  /** Is there an available-but-capped account (not excluded)? A freed slot could serve it. (`exclude` = Set of account objects.) */
  anyCapped(exclude = null) {
    return this.accounts.some(a =>
      this._isAvailable(a) && !this._hasCapacity(a) && !(exclude && exclude.has(a)));
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
      // Require the home to be MEASURED — not just past its warm-up tries. A
      // headerless account stays unmeasured forever; pinning a connection to it
      // would bypass getActiveAccount's unmeasured-rebalance (which keeps
      // spreading to gather quota data / let tokens refresh on use). Once an
      // account returns rate-limit headers (every real Anthropic response does),
      // affinity engages normally.
      if (a && this.accounts[a.index] === a && this._isMeasured(a) && this._isAvailable(a)
          && this._hasCapacity(a) && !(exclude && exclude.has(a))) {
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
        && !(eff && eff.has(account))) {
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
   * The caller MUST releaseAccount(account) exactly once when the request
   * (including any streamed body) finishes — pass the returned account OBJECT,
   * not its index, so a concurrent removeAccount() can't misattribute the slot.
   * `exclude` is a Set of account OBJECTS (per-request failover).
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

  /**
   * Upper bound on concurrent in-flight requests the proxy may admit (server.js
   * caps `inFlightProxied` to this to bound buffered memory): each ENABLED
   * account contributes its full cap (capacity it can still take), each DISABLED
   * account contributes only its *current* in-flight (requests still draining —
   * it accepts no new ones), plus the queue depth.
   *
   * This is the tightest bound that's still safe: it covers the draining requests
   * on a just-disabled account (so they can't push inFlightProxied over the
   * ceiling and 429 traffic the enabled accounts could serve), without admitting
   * fresh requests against a disabled account's dead future capacity (which could
   * only be buffered and then 429'd at acquire). As those draining requests
   * finish, the disabled account's contribution falls to zero.
   */
  totalCapacity() {
    const caps = this.accounts.reduce(
      (sum, a) => sum + (a.enabled === false ? a.inflight : a.maxConcurrent), 0);
    return caps + this.maxQueueDepth;
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
  releaseAccount(accountOrIndex) {
    // Resolve to the account OBJECT (what the server holds — reindex-safe across a
    // removeAccount) so a release decrements the slot of the *account that was
    // acquired*, never whatever happens to sit at that index now. A numeric index
    // is still accepted for convenience/tests.
    const account = this._resolve(accountOrIndex);
    if (account && account.inflight > 0) account.inflight--;
    this._drainWaiters();
  }

  _drainWaiters() {
    for (let i = 0; i < this._waiters.length;) {
      const waiter = this._waiters[i];
      const account = this._tryAcquire(waiter.exclude, waiter.affinityKey);
      if (account) {
        // _settleWaiter splices the waiter out, so don't advance i. If it was
        // already settled (shouldn't happen — settled waiters aren't in the list),
        // give the slot back instead of leaking it.
        if (!this._settleWaiter(waiter, account)) { account.inflight--; i++; }
        continue;
      }
      // No slot right now. If no account this waiter could use is even
      // available-but-capped, nothing will ever free for it (e.g. the account it
      // was queued for just got disabled or exhausted) — settle it null so it
      // releases its finite queue slot instead of blocking later, satisfiable
      // overflow requests until its timeout. A waiter that still has a cappable
      // account to hope for is left in place.
      if (!this.anyCapped(waiter.exclude)) { this._settleWaiter(waiter, null); continue; }
      i++;
    }
  }

  /**
   * Highest-priority available account by use-or-lose ordering: soonest WEEKLY
   * (7d) reset first — weekly quota is the scarce resource, so an account whose
   * week is about to renew (and whose unspent quota would be wasted) is drained
   * first — then soonest session reset, then lowest session utilization. Falls
   * back to the soonest-resetting account when none are currently available.
   *
   * `exclude` (a Set of account objects) is used for per-request failover: those
   * accounts are skipped, and when nothing else is eligible this returns null
   * (instead of recovering one) so the caller can pass the 429 through.
   */
  _selectBest(exclude = null) {
    const has = a => (exclude ? exclude.has(a) : false);
    const eligible = this.accounts.filter(a => this._isAvailable(a) && !has(a));
    if (eligible.length === 0) return exclude ? null : this._recoverSoonest();

    eligible.sort((a, b) => {
      const pa = this._priority(a);
      const pb = this._priority(b);
      if (pa !== pb) return pa - pb;                                     // explicit priority first (lower = preferred)
      return this.autoCompare(a, b);                                     // then the automatic use-or-lose order
    });

    // Accounts tied for the best rank (notably all-unknown at cold start, or all
    // sharing one priority) are load-balanced round-robin instead of always
    // pinning to the lowest index, so a startup burst can't pile onto one account
    // before quotas are known.
    const p0 = this._priority(eligible[0]);
    const w0 = this._weeklyResetTime(eligible[0]);
    const r0 = this._sessionResetTime(eligible[0]);
    const u0 = this._sessionUtilization(eligible[0]);
    const tied = eligible
      .filter(a => this._priority(a) === p0
        && this._weeklyResetTime(a) === w0
        && this._sessionResetTime(a) === r0
        && this._sessionUtilization(a) === u0)
      .sort((a, b) => a.index - b.index);
    if (tied.length <= 1) return eligible[0];
    return tied.find(a => a.index > this.currentIndex) || tied[0];
  }

  /**
   * Explicit selection priority: lower = preferred. Unset (null) sorts last
   * (Infinity) so an account WITH any finite priority — however large — is chosen
   * ahead of those without. When no account sets a priority, every account ties
   * here (Infinity === Infinity) and the sort falls through to use-or-lose, i.e.
   * the original behavior unchanged. The callers compare with a `pa !== pb` guard
   * before any subtraction, so Infinity never produces a NaN sort key.
   */
  _priority(account) {
    return Number.isFinite(account.priority) ? account.priority : Infinity;
  }

  /**
   * The automatic ("auto") use-or-lose comparator, shared by selection and the
   * TUI display order: soonest WEEKLY reset (drain what renews first) → soonest
   * session reset → lowest session utilization. Returns 0 on a full tie, so a
   * stable sort keeps ties in array order (the pre-weekly behavior for API-key
   * fleets and unmeasured accounts).
   */
  autoCompare(a, b) {
    const wa = this._weeklyResetTime(a);
    const wb = this._weeklyResetTime(b);
    if (wa !== wb) return wa - wb;
    const ra = this._sessionResetTime(a);
    const rb = this._sessionResetTime(b);
    if (ra !== rb) return ra - rb;
    return this._sessionUtilization(a) - this._sessionUtilization(b);
  }

  /**
   * Weekly reset timestamp (ms): unified 7d (Max) → Infinity. API-key accounts
   * have no weekly window, so they tie at Infinity and the session tiebreak
   * decides — exactly the pre-weekly-ordering behavior. The window counts only
   * when BOTH utilization and reset are present: a partial/garbled header pair
   * (reset without utilization) must not outrank accounts with no 7d data,
   * matching the documented "no weekly data ranks at Infinity" semantics.
   *
   * A timestamp that has PASSED ranks at Infinity too: the moment a window
   * rolls over, the account's old "resets soonest" claim is void (its fresh
   * window is unknown until re-measured) — without this, the past timestamp
   * (smallest value) would pin the account at the top of the order until a
   * request-path sweep happened to clear it, so the order would NOT follow
   * reset rollovers. The lazy sweep in _isNearQuota still clears the fields;
   * this just makes ORDERING (selection and the TUI display, which has no
   * sweep) reflect the rollover instantly.
   */
  _weeklyResetTime(account) {
    const q = account.quota;
    const r = (q.unified7d != null && q.unified7dReset) ? q.unified7dReset : Infinity;
    return r > Date.now() ? r : Infinity;
  }

  /**
   * Session reset timestamp (ms): unified 5h (Max) → standard reset → Infinity.
   * Expired timestamps rank at Infinity for the same rollover reason as
   * _weeklyResetTime above.
   */
  _sessionResetTime(account) {
    const q = account.quota;
    const r = q.unified5hReset
      || (q.resetsAt ? new Date(q.resetsAt).getTime() : Infinity);
    return r > Date.now() ? r : Infinity;
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

  /**
   * Clear every account's expired quota windows NOW. The lazy sweep inside
   * _isNearQuota only runs on selection paths (i.e. when a request flows), so
   * on an idle proxy a rolled-over window would keep its stale values — and
   * stay "measured", which prevents the periodic active warm-up from
   * re-probing it. The server's warm-up timer calls this first, closing the
   * loop: rollover → sweep → unmeasured → probe → fresh data → order updates.
   * Idempotent and cheap (pure field clears).
   */
  sweepExpired() {
    for (const a of this.accounts) this._isNearQuota(a);
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

  /**
   * Accounts eligible for an *active* warm-up probe: available (enabled, not
   * throttled / exhausted / error), with no quota data yet, AND not already
   * handling a request. The server sends each one a minimal upstream request to
   * populate its quota so the dashboard reflects the whole fleet shortly after a
   * (re)start, instead of waiting for client traffic to organically reach every
   * account.
   *
   * `inflight === 0` matters: a request already in flight will itself populate
   * the account's quota (updateQuota runs on its response headers), so probing it
   * would just race that request and waste an upstream call. Cold start's very
   * first request holds its (still-unmeasured) account here, so the startup
   * fan-out probes only the genuinely idle rest of the fleet — never the account
   * that request is already measuring. (An unmeasured account can't be near-quota,
   * so no extra status carve-outs are needed beyond _isAvailable.)
   */
  warmupCandidates() {
    return this.accounts.filter(a =>
      this._isAvailable(a) && !this._isMeasured(a) && a.inflight === 0);
  }

  _isAvailable(account) {
    if (!account) return false;

    // Manually disabled accounts are out of rotation entirely. This single gate
    // covers every selection path (warm-up target, _selectBest, _cappedSet,
    // anyUsable/anyCapped, the sticky-current check) so a disabled account is
    // never chosen for a new request. _recoverSoonest iterates accounts directly
    // (not via this), so it skips disabled accounts itself.
    if (account.enabled === false) return false;

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

    // Clear expired unified quotas. The reset timestamp is cleared even when the
    // matching utilization was never set (a partial/garbled header pair) — a
    // stale past timestamp would otherwise survive forever and, since selection
    // sorts by reset time, permanently bias the ordering toward that account.
    if (q.unified5hReset && now >= q.unified5hReset) {
      if (q.unified5h != null) console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
    }
    if (q.unified7dReset && now >= q.unified7dReset) {
      if (q.unified7d != null) console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
    }
    // Clear expired model-scoped weekly windows (display-only, but a stale
    // "94% Fable" bar after the window reset would mislead)
    for (const [label, win] of Object.entries(q.modelWeekly)) {
      if (win.reset && now >= win.reset) {
        console.log(`[TeamClaude] Account "${account.name}" ${label} quota reset`);
        delete q.modelWeekly[label];
      }
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
      // Never recover a manually-disabled account into rotation.
      if (account.enabled === false) continue;
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
    const account = this._resolve(accountIndex);
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

    // Model-scoped weekly windows (7d_<label>), e.g. `7d_oi` — the weekly limit
    // for the top model tier ("Fable" in Claude's usage UI). These headers only
    // appear on responses to requests for that model tier, so the value sticks
    // around from the last such request. Matched generically so a renamed or
    // newly added window is picked up as-is.
    for (const [key, value] of Object.entries(headers)) {
      const m = /^anthropic-ratelimit-unified-(7d_[a-z0-9_]+)-(utilization|reset)$/.exec(key);
      if (!m) continue;
      const win = account.quota.modelWeekly[m[1]]
        || (account.quota.modelWeekly[m[1]] = { utilization: null, reset: null });
      if (m[2] === 'utilization') {
        const u = parseFloat(value);
        if (!isNaN(u)) win.utilization = u;
      } else {
        const r = parseInt(value, 10);
        if (!isNaN(r)) win.reset = r * 1000;
      }
    }

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
    const account = this._resolve(accountIndex);
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
   *
   * Model-scoped windows (quota.modelWeekly, e.g. the Fable 7d_oi limit) are
   * deliberately NOT consulted here. On a real upstream 429 for that model tier
   * the top-level `unified-status` is `rejected` too (the binding claim is
   * reflected there — verified against live traffic), so the exhaustion IS
   * detected; folding 7d_oi in additionally would change nothing on real
   * headers, and reacting to it alone would globally throttle an account that
   * still serves every other model. Per-model routing (skip Fable-exhausted
   * accounts only for Fable requests, without the 5-min global throttle) would
   * need the request's model plumbed into selection — a separate feature.
   */
  isExhausted(accountIndex) {
    const account = this._resolve(accountIndex);
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
    const account = this._resolve(accountIndex);
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
    const account = this._resolve(accountIndex);
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
        // Only persist if the account is still live at its claimed index. If it was
        // removed during the (awaited) network refresh, its `.index` is stale and
        // would misattribute the write to the survivor that shifted into that slot
        // — and a deleted account's tokens don't need persisting anyway.
        if (this.accounts[account.index] === account) this._onTokenRefresh?.(account.index, newTokens);
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
    const account = this._resolve(accountIndex);
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    // Same liveness guard as ensureTokenFresh: never emit a stale index for a
    // removed account (here the path is synchronous, but keep the invariant uniform).
    if (this.accounts[account.index] === account) this._onTokenRefresh?.(account.index, {
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
      enabled: acctData.enabled !== false,
      priority: Number.isFinite(acctData.priority) ? Math.floor(acctData.priority) : null,
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acctData.maxConcurrent, this.maxConcurrentDefault),
    });
    // The new account has free capacity — hand it to any request waiting in the
    // overflow queue instead of letting it time out to a 429 while a usable
    // account sits idle.
    this._drainWaiters();
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
   * Resolve a caller-facing account reference — an account object or a name
   * string — to the live account object (or null). Used by the public
   * setEnabled/setPriority.
   *
   * A bare numeric index is intentionally NOT accepted here (unlike the internal
   * `_resolve`): a setter is a mutation, and an index captured before a
   * removeAccount() re-index would silently disable/reprioritize whatever account
   * shifted into that slot. Callers pass the account object (TUI / sync) or its
   * name (CLI) — both survive a re-index.
   */
  _resolveRef(ref) {
    if (typeof ref === 'string') return this.accounts.find(a => a.name === ref) || null;
    if (ref && typeof ref === 'object') return this.accounts.includes(ref) ? ref : null;
    return null;
  }

  /**
   * Enable or disable an account at runtime. A disabled account is excluded from
   * rotation (via _isAvailable) but keeps any in-flight requests until they
   * finish. Re-enabling hands its now-free capacity to any queued waiters.
   * Returns the affected account, or null if `ref` matched nothing.
   */
  setEnabled(ref, enabled) {
    const account = this._resolveRef(ref);
    if (!account) return null;
    account.enabled = enabled !== false;
    // Re-evaluate the overflow queue either way: re-enabling hands the account's
    // free slots to waiters; disabling may leave a waiter that could *only* be
    // served by this account with no hope — _drainWaiters settles those now (so
    // they release their finite queue slot) instead of stranding them to timeout.
    this._drainWaiters();
    this._reprioritize();
    return account;
  }

  /**
   * Set (or clear) an account's explicit selection priority. Lower number =
   * preferred first; pass null/undefined/NaN to clear it (back to use-or-lose).
   * Returns the affected account, or null if `ref` matched nothing.
   */
  setPriority(ref, priority) {
    const account = this._resolveRef(ref);
    if (!account) return null;
    account.priority = Number.isFinite(priority) ? Math.floor(priority) : null;
    this._reprioritize();
    return account;
  }

  /**
   * A preference change (enable/disable/priority) should take effect promptly,
   * not wait out the sticky `reevalIntervalMs` window (and not at all when the
   * timer is off). Re-pick the active account *directly* here — in either mode —
   * but ONLY when it actually matters: the current account is no longer usable
   * (e.g. just disabled), or a strictly higher-priority account is available.
   *
   * A no-op change (or one that doesn't dethrone the current account) leaves the
   * sticky primary untouched, so it can't churn cache locality. We deliberately
   * do NOT reset `lastEvalAt` to 0 — that would wake the periodic timer re-eval,
   * whose tie round-robin would switch the primary even when nothing changed.
   */
  _reprioritize() {
    const current = this.accounts[this.currentIndex];
    const best = this._selectBest();
    if (!best || best.index === this.currentIndex) return;
    // Switch only when `best` is *strictly* preferred over the current account by
    // the full selection order (priority → soonest reset → least used), or the
    // current account is unusable. Comparing the full order — not priority alone —
    // means clearing a priority correctly restores use-or-lose routing, while a
    // true tie (best ranks equal to current) still leaves the sticky primary put
    // so there's no cache-churn.
    if (this._isAvailable(current) && !this._strictlyPrefer(best, current)) return;
    this.currentIndex = best.index;
    this.lastEvalAt = Date.now(); // just evaluated — don't also trigger a timer re-eval
  }

  /**
   * Is account `a` strictly preferred over `b` by the same lexicographic order
   * `_selectBest` sorts on: explicit priority (lower first), then soonest weekly
   * reset, then soonest session reset, then lowest utilization. Returns false
   * when they rank equal (a tie).
   */
  _strictlyPrefer(a, b) {
    const pa = this._priority(a), pb = this._priority(b);
    if (pa !== pb) return pa < pb;
    const wa = this._weeklyResetTime(a), wb = this._weeklyResetTime(b);
    if (wa !== wb) return wa < wb;
    const ra = this._sessionResetTime(a), rb = this._sessionResetTime(b);
    if (ra !== rb) return ra < rb;
    return this._sessionUtilization(a) < this._sessionUtilization(b);
  }

  /**
   * Snapshot of per-account quota state for persistence across restarts
   * (credential-free). Quota lives only in memory otherwise, so a restart used
   * to blank the whole dashboard (and blind use-or-lose ordering) until traffic
   * organically re-measured every account.
   */
  exportQuotaState() {
    return this.accounts.map(a => ({
      accountUuid: a.accountUuid || null,
      name: a.name,
      quota: {
        ...a.quota,
        modelWeekly: Object.fromEntries(
          Object.entries(a.quota.modelWeekly).map(([k, w]) => [k, { ...w }])),
      },
      rateLimitedUntil: a.rateLimitedUntil,
      usage: { ...a.usage },
    }));
  }

  /**
   * Restore a quota snapshot from a previous run. A snapshot entry WITH an
   * accountUuid is matched by uuid ONLY — a same-name account with a different
   * uuid is a *replaced* account (a different underlying identity), and
   * restoring the old quota/throttle onto it would falsely mark a fresh
   * account near-quota or throttled. Name matching is the fallback solely for
   * entries without a uuid (API-key accounts, whose identity key is the name).
   * Unknown entries are skipped (→ unmeasured, exactly the pre-restore state).
   * Values may be slightly stale, but the proxy takes no traffic while it's
   * down, and expired windows are lazily swept by _isNearQuota on first use —
   * so a restore is strictly better than starting blind. A still-future
   * rateLimitedUntil re-throttles the account; error/exhausted statuses are
   * deliberately NOT restored (a bad token may have been fixed since).
   */
  importQuotaState(saved) {
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s || typeof s !== 'object') continue;
      const a = s.accountUuid
        ? this.accounts.find(x => x.accountUuid === s.accountUuid)
        : this.accounts.find(x => x.name === s.name);
      if (!a) continue;
      if (s.quota && typeof s.quota === 'object') {
        // Merge over emptyQuota so a cache written by an older version (missing
        // newer fields like modelWeekly) still yields a complete quota object.
        a.quota = {
          ...emptyQuota(),
          ...s.quota,
          // unifiedStatus is a PER-RESPONSE signal — isExhausted() treats a
          // 'rejected' here as "this 429 is account exhaustion". Restoring a
          // stale one would misclassify a later transient/headerless 429 as
          // exhaustion and wrongly throttle the account. Only a live response
          // (updateQuota) may set it.
          unifiedStatus: null,
          modelWeekly: Object.fromEntries(
            Object.entries(s.quota.modelWeekly && typeof s.quota.modelWeekly === 'object' ? s.quota.modelWeekly : {})
              .map(([k, w]) => [k, { ...w }])),
        };
      }
      if (s.usage && typeof s.usage === 'object') a.usage = { ...a.usage, ...s.usage };
      if (Number.isFinite(s.rateLimitedUntil) && s.rateLimitedUntil > Date.now()) {
        a.rateLimitedUntil = s.rateLimitedUntil;
        a.status = 'throttled';
      }
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
        enabled: a.enabled !== false,
        priority: a.priority ?? null,
        // Deep-copy the nested modelWeekly map — the shallow quota spread would
        // otherwise hand callers a live reference into account state.
        quota: {
          ...a.quota,
          modelWeekly: Object.fromEntries(
            Object.entries(a.quota.modelWeekly).map(([k, w]) => [k, { ...w }])),
        },
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
