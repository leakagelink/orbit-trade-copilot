-- Rollback for DRAFT 0045 (not applied). Export futures_paper_accounts, futures_paper_events and strategy_risk_budgets
-- first: dropping them deletes the Futures paper history and strategy budgets. No real-trading, wallet, Spot paper or
-- research object is touched; the Central Risk Engine then reads "no strategy budget" and returns INSUFFICIENT_DATA.
DROP FUNCTION public.futures_paper_commit_bar(uuid, bigint, bigint, jsonb);
DROP TABLE public.futures_paper_events;
DROP TABLE public.futures_paper_accounts;
DROP TABLE public.strategy_risk_budgets;
DROP FUNCTION public.guard_strategy_risk_budget();
DROP FUNCTION public.guard_futures_paper_account();
DROP FUNCTION public.futures_paper_history_immutable();
