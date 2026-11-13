// Reference SQL for a Futures PAPER worker database port against DRAFT migration 0049 (not applied). Strings only — no
// client, no connection, nothing executes here. The real-PostgreSQL tests run exactly these statements; a hosted port
// would need them wrapped in service-only functions (not drafted: activation is a separate owner approval).
export const FP_SQL = {
  account: `SELECT id, user_id, status, halted, seq, cursor_t, tf_ms, timeframe, symbols, config, state FROM public.futures_paper_accounts WHERE id = $1`,
  accountBudget: `SELECT max_loss, research_max_loss, scalping_max_loss FROM public.account_risk_budgets WHERE user_id = $1 AND environment = 'paper'`,
  // Same definition as fp3_usage: closed losses per (account, proposal) with an exit (wins never refill) + open reserved
  // risk + pending approval remainders, owner-wide across every paper account, per budgeted strategy.
  usage: `WITH s AS (SELECT strategy_id, engine, max_loss FROM public.strategy_risk_budgets WHERE user_id = $1 AND environment = 'paper'),
  q AS (SELECT ev.strategy_id, sum(ev.wallet_delta) AS net FROM public.futures_paper_events ev
         WHERE ev.user_id = $1 AND ev.proposal_id IS NOT NULL AND ev.strategy_id IN (SELECT strategy_id FROM s)
         GROUP BY ev.account_id, ev.proposal_id, ev.strategy_id HAVING bool_or(ev.kind IN ('exit_fill', 'liquidation'))),
  c AS (SELECT strategy_id, sum(greatest(0, -net)) AS v FROM q GROUP BY strategy_id),
  o AS (SELECT strategy_id, sum(risk_reserved) AS v FROM public.futures_paper_positions WHERE user_id = $1 GROUP BY strategy_id),
  p AS (SELECT strategy_id, sum((approved_qty - filled_qty) * (stop_dist + reference_price * cost_pct / 100)) AS v
         FROM public.futures_paper_risk_approvals WHERE user_id = $1 AND status = 'open' GROUP BY strategy_id)
  SELECT s.strategy_id, s.engine, s.max_loss, coalesce(c.v, 0) AS closed_loss, coalesce(o.v, 0) AS open_risk, coalesce(p.v, 0) AS pending_risk
    FROM s LEFT JOIN c USING (strategy_id) LEFT JOIN o USING (strategy_id) LEFT JOIN p USING (strategy_id) ORDER BY s.strategy_id`,
  costs: `SELECT strategy_id, symbol, round_trip_cost_pct, validation_status FROM public.futures_paper_cost_assumptions WHERE user_id = $1`,
  approvals: `SELECT proposal_id, strategy_id, budget_engine, symbol, side, approved_qty, filled_qty, leverage, reference_price, reference_t, stop_dist, cost_pct, expires_t
    FROM public.futures_paper_risk_approvals WHERE account_id = $1 AND status = 'open'`,
  positions: `SELECT symbol, proposal_id, strategy_id, risk_reserved FROM public.futures_paper_positions WHERE account_id = $1`,
  evaluated: `SELECT proposal_id FROM public.futures_paper_risk_approvals WHERE user_id = $1 AND proposal_id = ANY($2::text[])`,
  commit: `SELECT public.futures_paper_commit_bar_v3($1, $2, $3, $4::jsonb) AS seq`,
  // Session-level advisory lease: released by the server if the worker's connection dies (crash-safe).
  lease: `SELECT pg_try_advisory_lock(hashtext('fp-worker:' || $1)) AS ok`,
  release: `SELECT pg_advisory_unlock(hashtext('fp-worker:' || $1)) AS ok`,
  // Review hold: entries stop (0049 refuses them while paused); exits keep running on later ticks; never un-paused here.
  markForReview: `UPDATE public.futures_paper_accounts SET status = 'paused', status_reason = $2 WHERE id = $1 AND status = 'active'`,
} as const;
