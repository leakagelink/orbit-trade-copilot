-- Rollback for DRAFT 0046 (not applied; supersedes draft 0045). Export futures_paper_accounts, futures_paper_events,
-- futures_paper_positions, futures_paper_commits and strategy_risk_budgets first: dropping them deletes the Futures paper
-- history and strategy budgets. No real-trading, wallet, Spot paper or research object is touched; afterwards the
-- Central Risk Engine reads "no strategy budget" and returns INSUFFICIENT_DATA. No CASCADE is used.
DROP FUNCTION public.futures_paper_commit_bar_v2(uuid, bigint, bigint, jsonb);
DROP TABLE public.futures_paper_events;
DROP TABLE public.futures_paper_commits;
DROP TABLE public.futures_paper_positions;
DROP TABLE public.futures_paper_accounts;
DROP TABLE public.strategy_risk_budgets;
DROP FUNCTION public.guard_strategy_risk_budget();
DROP FUNCTION public.guard_futures_paper_book();
DROP FUNCTION public.guard_futures_paper_account();
DROP FUNCTION public.futures_paper_in_commit();
DROP FUNCTION public.futures_paper_history_immutable();
DROP FUNCTION public.fp2_txt(jsonb, text, boolean);
DROP FUNCTION public.fp2_int(jsonb, text);
DROP FUNCTION public.fp2_num(jsonb, text);
DROP FUNCTION public.fp2_finite(numeric);
