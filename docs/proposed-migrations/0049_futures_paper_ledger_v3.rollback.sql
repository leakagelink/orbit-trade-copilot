-- Rollback for DRAFT 0049 (not applied; supersedes drafts 0046 and 0045). Export every table below first: dropping
-- them deletes the Futures paper history, risk approvals, candles, cost assumptions and all paper risk budgets. No
-- real-trading, wallet, Spot paper, research or attribution (0048) object is touched. No CASCADE is used.
DROP FUNCTION public.futures_paper_commit_bar_v3(uuid, bigint, bigint, jsonb);
DROP FUNCTION public.fp3_check_account(uuid, jsonb, text, numeric, text, text);
DROP FUNCTION public.fp3_daily_left(uuid, bigint, jsonb, text);
DROP FUNCTION public.fp3_usage(uuid, text, text);
DROP FUNCTION public.fp3_cost(uuid, text, text, numeric);
DROP FUNCTION public.fp3_mark(jsonb, text, text);
DROP TABLE public.futures_paper_events;
DROP TABLE public.futures_paper_commits;
DROP TABLE public.futures_paper_positions;
DROP TABLE public.futures_paper_risk_approvals;
DROP TABLE public.futures_paper_candles;
DROP TABLE public.futures_paper_accounts;
DROP TABLE public.futures_paper_cost_assumptions;
DROP TABLE public.strategy_risk_budgets;
DROP TABLE public.account_risk_budgets;
DROP FUNCTION public.guard_futures_paper_cost();
DROP FUNCTION public.guard_strategy_risk_budget();
DROP FUNCTION public.guard_account_risk_budget();
DROP FUNCTION public.guard_futures_paper_approval();
DROP FUNCTION public.guard_futures_paper_book();
DROP FUNCTION public.guard_futures_paper_account();
DROP FUNCTION public.futures_paper_in_commit();
DROP FUNCTION public.futures_paper_history_immutable();
DROP FUNCTION public.fp3_near(numeric, numeric);
DROP FUNCTION public.fp2_txt(jsonb, text, boolean);
DROP FUNCTION public.fp2_int(jsonb, text);
DROP FUNCTION public.fp2_num(jsonb, text);
DROP FUNCTION public.fp2_finite(numeric);
