-- Rollback for DRAFT 0044 (not applied). Export paper_accounts, paper_strategies, paper_bars, paper_order_events and
-- paper_trades first: dropping them deletes the forward paper trading history. No real-trading, wallet or research
-- object is touched; the app shows "paper ledger not enabled" afterwards and the paper tick does nothing.
DROP FUNCTION public.paper_commit_bar(uuid, bigint, jsonb);
DROP TABLE public.paper_trades;
DROP TABLE public.paper_order_events;
DROP TABLE public.paper_bars;
DROP TABLE public.paper_strategies;
DROP TABLE public.paper_accounts;
DROP FUNCTION public.guard_paper_strategy();
DROP FUNCTION public.guard_paper_account();
DROP FUNCTION public.paper_history_immutable();
