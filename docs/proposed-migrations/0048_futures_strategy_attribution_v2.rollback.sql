-- ROLLBACK for DRAFT 0048 (futures strategy attribution v2, successor of 0047). DRAFT ONLY — never applied. Removes only
-- objects 0048 created; it does not touch public.orders, public.positions or public.trades. Run in ONE transaction.
-- No CASCADE. Refuses (fails) if anything else came to depend on these objects.
DROP VIEW public.futures_trade_strategy_attribution;
DROP VIEW public.futures_strategy_attribution_totals;
DROP VIEW public.futures_strategy_attribution_effective;
DROP FUNCTION public.claim_futures_order_strategy_identity(uuid, text, integer, text);
DROP TABLE public.futures_strategy_attribution_events;
DROP TABLE public.futures_order_strategy_identity;
DROP FUNCTION public.guard_futures_attribution_event();
DROP FUNCTION public.futures_attribution_effective_qty(uuid);
DROP FUNCTION public.guard_futures_order_strategy_identity();
DROP FUNCTION public.futures_attribution_immutable();
